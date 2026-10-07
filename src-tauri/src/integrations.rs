// Service pollers for the integration activities (GitHub, Vercel, Stripe, Notion,
// n8n, Cal.com, Resend). `integration_poll` asks one service for a fresh snapshot
// and hands it back as JSON; the TypeScript activity compares it with the last one
// and decides what is worth showing. Endpoints and parsing follow Coucou's pollers
// (MIT, Louis Raillé), which is also where the key handling comes from: a key is
// read from the Credential Manager here, goes only to that service's own API host,
// and is never logged or returned. A failed poll is `{ ok: false, code, error }`.
//
// Names of the secrets (`<activity>.<option>`) match the catalog entries in
// src/activities/catalog.ts.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};

use crate::secrets;

const GITHUB_TOKEN: &str = "github.token";
const VERCEL_TOKEN: &str = "vercel.token";
const STRIPE_KEY: &str = "stripe.key";
const NOTION_TOKEN: &str = "notion.token";
const N8N_KEY: &str = "n8n.key";
const CALCOM_KEY: &str = "calcom.key";
const RESEND_KEY: &str = "resend.key";

/// Executions and pages come back in the thousands of bytes; anything past this is not for the pill.
const MAX_DETAIL_BYTES: u64 = 2 * 1024 * 1024;

// ------------------------------------------------------------------ plumbing

/// Why a poll failed: a short sentence for the pill and a code the activity can branch on
/// (`no-key`, `config`, `auth`, `limit`, `http`, `network`).
struct Failure {
    code: &'static str,
    message: String,
    retry_after: Option<u64>,
}

impl Failure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Failure { code, message: message.into(), retry_after: None }
    }
}

type Poll = Result<Value, Failure>;

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent(concat!("Island/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default()
    })
}

fn need_key(name: &str) -> Result<String, Failure> {
    secrets::get(name).ok_or_else(|| Failure::new("no-key", "No key saved"))
}

/// The status line the pill shows, as Coucou's pollers worded it.
fn status_failure(code: u16, forbidden: &str, retry_after: Option<u64>) -> Failure {
    let (kind, message) = match code {
        401 => ("auth", "Invalid API key (401)".to_string()),
        403 if !forbidden.is_empty() => ("auth", forbidden.to_string()),
        403 => ("auth", "Access denied (403)".to_string()),
        429 => ("limit", "Rate limited, trying again later".to_string()),
        _ => ("http", format!("API error {code}")),
    };
    Failure { code: kind, message, retry_after }
}

/// Never put the error text in the message: a self-hosted base URL can carry credentials.
fn network_failure(e: &reqwest::Error) -> Failure {
    let message = if e.is_timeout() { "The service took too long to answer" } else { "No connection" };
    Failure::new("network", message)
}

/// Sends a request and returns its JSON body; any non-2xx status becomes a Failure.
async fn fetch(req: reqwest::RequestBuilder, forbidden: &str) -> Result<Value, Failure> {
    let resp = req.send().await.map_err(|e| network_failure(&e))?;
    let status = resp.status();
    if !status.is_success() {
        let retry = resp.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|s| s.trim().parse::<u64>().ok());
        return Err(status_failure(status.as_u16(), forbidden, retry));
    }
    if resp.content_length().is_some_and(|n| n > MAX_DETAIL_BYTES) {
        return Err(Failure::new("http", "Response too large"));
    }
    resp.json::<Value>().await.map_err(|_| Failure::new("http", "Unexpected response"))
}

/// The last message logged per service, so a service that is down is logged once, not every poll.
fn note(id: &str, outcome: &Poll) {
    static LAST: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    let Ok(mut last) = LAST.get_or_init(Default::default).lock() else { return };
    match outcome {
        Ok(_) => {
            last.remove(id);
        }
        Err(f) if f.code == "no-key" => {}
        Err(f) => {
            let line = format!("{}: {}", f.code, f.message);
            if last.get(id) != Some(&line) {
                crate::log::line(format!("integration {id} failed ({line})"));
                last.insert(id.to_string(), line);
            }
        }
    }
}

/// One snapshot of one service. `options` carries the activity's non-secret settings.
#[tauri::command]
pub async fn integration_poll(id: String, options: Option<Value>) -> Value {
    let options = options.unwrap_or(Value::Null);
    let outcome = match id.as_str() {
        "github" => github(&options).await,
        "vercel" => vercel(&options).await,
        "stripe" => stripe().await,
        "notion" => notion().await,
        "n8n" => n8n(&options).await,
        "calcom" => calcom().await,
        "resend" => resend().await,
        _ => Err(Failure::new("config", format!("unknown integration {id}"))),
    };
    note(&id, &outcome);
    match outcome {
        Ok(Value::Object(mut map)) => {
            map.insert("ok".into(), Value::Bool(true));
            Value::Object(map)
        }
        Ok(other) => json!({ "ok": true, "data": other }),
        Err(f) => json!({ "ok": false, "code": f.code, "error": f.message, "retryAfter": f.retry_after }),
    }
}

// ------------------------------------------------------------------ GitHub

/// `owner/name` pairs from the options, at most five, anything odd dropped.
fn watch_list(options: &Value) -> Vec<String> {
    let valid = |s: &str| {
        let mut parts = s.split('/');
        // "." and ".." are not names: they would walk out of /repos/ in the request path.
        let ok = |p: Option<&str>| p.is_some_and(|p| !p.is_empty() && !p.bytes().all(|b| b == b'.') && p.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_')));
        ok(parts.next()) && ok(parts.next()) && parts.next().is_none()
    };
    options["repos"]
        .as_array()
        .map(|list| list.iter().filter_map(Value::as_str).map(str::trim).filter(|s| valid(s)).map(str::to_string).take(5).collect())
        .unwrap_or_default()
}

fn parse_runs(body: &Value, repo: &str) -> Vec<Value> {
    body["workflow_runs"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|r| {
                    Some(json!({
                        "id": r["id"].as_i64()?,
                        "repo": repo,
                        "name": r["name"].as_str().unwrap_or("Workflow"),
                        "title": r["display_title"].as_str().unwrap_or(""),
                        "branch": r["head_branch"].as_str().unwrap_or(""),
                        "status": r["status"].as_str().unwrap_or(""),
                        "conclusion": r["conclusion"].as_str(),
                        "url": r["html_url"].as_str().unwrap_or(""),
                        "updatedAt": r["updated_at"].as_str().unwrap_or(""),
                    }))
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn github(options: &Value) -> Poll {
    let token = need_key(GITHUB_TOKEN)?;
    let api = |path: &str| {
        client()
            .get(format!("https://api.github.com{path}"))
            .bearer_auth(&token)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
    };

    let me = fetch(api("/user"), "Token lacks the scope it needs").await?;
    let login = me["login"].as_str().unwrap_or("").to_string();
    let public = me["public_repos"].as_i64().unwrap_or(0);
    let private = me["owned_private_repos"].as_i64().or_else(|| me["total_private_repos"].as_i64()).unwrap_or(0);

    // Stars come from the owner's repositories, most recently pushed first. The same list
    // gives a default set of repositories to watch when the options name none.
    let owned = fetch(api("/user/repos?per_page=100&affiliation=owner&sort=pushed"), "").await.ok();
    let owned = owned.as_ref().and_then(Value::as_array);
    let stars = owned.map(|list| list.iter().filter_map(|r| r["stargazers_count"].as_i64()).sum::<i64>());
    let mut watched = watch_list(options);
    if watched.is_empty() {
        if let Some(list) = owned {
            watched = list
                .iter()
                .filter(|r| !r["fork"].as_bool().unwrap_or(false) && !r["archived"].as_bool().unwrap_or(false))
                .filter_map(|r| r["full_name"].as_str().map(str::to_string))
                .take(3)
                .collect();
        }
    }

    // CI runs: a repository without Actions, or one the token cannot see, is simply skipped.
    let mut runs = Vec::new();
    for repo in &watched {
        if let Ok(body) = fetch(api(&format!("/repos/{repo}/actions/runs?per_page=3")), "").await {
            runs.extend(parse_runs(&body, repo));
        }
    }
    runs.sort_by(|a, b| b["updatedAt"].as_str().cmp(&a["updatedAt"].as_str()));
    runs.truncate(9);

    let reviews = if login.is_empty() {
        None
    } else {
        let query = [("q", format!("is:pr is:open review-requested:{login}")), ("per_page", "1".to_string())];
        fetch(api("/search/issues").query(&query), "").await.ok().and_then(|b| b["total_count"].as_i64())
    };

    Ok(json!({
        "login": login,
        "profileUrl": me["html_url"].as_str().unwrap_or(""),
        "repos": public + private,
        "stars": stars,
        "reviewRequests": reviews,
        "watched": watched,
        "runs": runs,
    }))
}

// ------------------------------------------------------------------ Vercel

fn parse_deployments(body: &Value) -> Vec<Value> {
    body["deployments"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|d| {
                    let state = d["state"].as_str().or_else(|| d["readyState"].as_str())?;
                    let meta = &d["meta"];
                    let pick = |keys: [&str; 3]| keys.iter().find_map(|k| meta[*k].as_str()).map(str::to_string);
                    Some(json!({
                        "id": d["uid"].as_str()?,
                        "project": d["name"].as_str()?,
                        "url": d["url"].as_str().unwrap_or(""),
                        "inspectorUrl": d["inspectorUrl"].as_str().unwrap_or(""),
                        "state": state,
                        "target": d["target"].as_str(),
                        "createdAt": d["createdAt"].as_f64().unwrap_or(0.0),
                        "commit": pick(["githubCommitMessage", "gitlabCommitMessage", "bitbucketCommitMessage"]),
                        "branch": pick(["githubCommitRef", "gitlabCommitRef", "bitbucketBranch"]),
                    }))
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn vercel(options: &Value) -> Poll {
    let token = need_key(VERCEL_TOKEN)?;
    let mut req = client()
        .get("https://api.vercel.com/v6/deployments")
        .query(&[("limit", "6")])
        .bearer_auth(&token)
        .header("Accept", "application/json");
    // A team id (team_…) or a team slug; empty means the personal account.
    if let Some(team) = options["team"].as_str().map(str::trim).filter(|t| !t.is_empty() && t.len() < 80) {
        req = req.query(&[(if team.starts_with("team_") { "teamId" } else { "slug" }, team)]);
    }
    let body = fetch(req, "Token lacks access to that team").await?;
    Ok(json!({ "deployments": parse_deployments(&body) }))
}

// ------------------------------------------------------------------ Stripe

/// Available plus pending in the account's first currency, as (available, pending, currency).
fn parse_balance(body: &Value) -> (i64, i64, String) {
    let sum = |key: &str, currency: &str| -> i64 {
        body[key].as_array().map(|list| list.iter().filter(|b| b["currency"].as_str() == Some(currency)).filter_map(|b| b["amount"].as_i64()).sum()).unwrap_or(0)
    };
    let currency = ["available", "pending"]
        .iter()
        .find_map(|k| body[*k].as_array().and_then(|list| list.first()).and_then(|b| b["currency"].as_str()))
        .unwrap_or("usd")
        .to_string();
    (sum("available", &currency), sum("pending", &currency), currency)
}

fn parse_charges(body: &Value) -> Vec<Value> {
    body["data"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|c| {
                    let description = c["description"].as_str().or_else(|| c["billing_details"]["name"].as_str()).or_else(|| c["billing_details"]["email"].as_str());
                    Some(json!({
                        "id": c["id"].as_str()?,
                        "amount": c["amount"].as_i64()?,
                        "currency": c["currency"].as_str()?,
                        "description": description,
                        "createdAt": c["created"].as_i64().unwrap_or(0) * 1000,
                        "status": c["status"].as_str().unwrap_or("succeeded"),
                        "refunded": c["refunded"].as_bool().unwrap_or(false),
                    }))
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn stripe() -> Poll {
    let key = need_key(STRIPE_KEY)?;
    // Stripe takes the secret key as the user name of basic auth, with no password.
    let api = |path: &str| client().get(format!("https://api.stripe.com{path}")).basic_auth(&key, Some(""));
    let forbidden = "Use a secret or restricted key (sk_ or rk_), not a publishable one";

    let balance = fetch(api("/v1/balance"), forbidden).await?;
    let (available, pending, currency) = parse_balance(&balance);
    // A restricted key without access to charges still gets a balance.
    let payments = fetch(api("/v1/charges?limit=3"), forbidden).await.map(|b| parse_charges(&b)).unwrap_or_default();

    Ok(json!({
        "balance": available + pending,
        "available": available,
        "pending": pending,
        "currency": currency,
        "livemode": balance["livemode"].as_bool().unwrap_or(true),
        "payments": payments,
    }))
}

// ------------------------------------------------------------------ Notion

/// A page or database from /v1/search. Titles live in different places for each.
fn parse_notion_page(obj: &Value) -> Option<Value> {
    let id = obj["id"].as_str()?;
    let first_text = |rich: &Value| rich.as_array().and_then(|a| a.first()).and_then(|t| t["plain_text"].as_str()).filter(|t| !t.is_empty()).map(str::to_string);

    let mut title = None;
    if obj["object"].as_str() == Some("database") {
        title = first_text(&obj["title"]);
    } else if let Some(props) = obj["properties"].as_object() {
        title = props.values().filter(|p| p["type"].as_str() == Some("title")).find_map(|p| first_text(&p["title"]));
    }
    let emoji = obj["icon"].as_object().filter(|i| i.get("type").and_then(Value::as_str) == Some("emoji")).and_then(|i| i.get("emoji")).and_then(Value::as_str);

    Some(json!({
        "id": id,
        "title": title.unwrap_or_else(|| "Untitled".to_string()),
        "emoji": emoji,
        "lastEditedAt": obj["last_edited_time"].as_str()?,
        "url": obj["url"].as_str().unwrap_or("https://notion.so"),
    }))
}

async fn notion() -> Poll {
    let token = need_key(NOTION_TOKEN)?;
    let req = client()
        .post("https://api.notion.com/v1/search")
        .bearer_auth(&token)
        .header("Notion-Version", "2022-06-28")
        .json(&json!({ "sort": { "direction": "descending", "timestamp": "last_edited_time" }, "page_size": 3 }));
    let body = fetch(req, "The integration has no pages shared with it").await?;
    let pages: Vec<Value> = body["results"].as_array().map(|list| list.iter().filter_map(parse_notion_page).collect()).unwrap_or_default();
    Ok(json!({ "pages": pages }))
}

// ------------------------------------------------------------------ Cal.com

fn parse_bookings(body: &Value) -> Vec<Value> {
    body["data"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|b| {
                    let start = b["start"].as_str().or_else(|| b["startTime"].as_str())?;
                    let attendee = b["attendees"].as_array().and_then(|a| a.first());
                    let notes = b["responses"]["notes"]["value"].as_str().or_else(|| b["description"].as_str()).filter(|s| !s.is_empty());
                    let id = match &b["id"] {
                        Value::String(s) => s.clone(),
                        Value::Number(n) => n.to_string(),
                        _ => return None,
                    };
                    Some(json!({
                        "id": id,
                        "uid": b["uid"].as_str().unwrap_or(""),
                        "title": b["title"].as_str().unwrap_or("Meeting"),
                        "start": start,
                        "end": b["end"].as_str().or_else(|| b["endTime"].as_str()),
                        "status": b["status"].as_str().unwrap_or("accepted"),
                        "attendeeName": attendee.and_then(|a| a["name"].as_str()),
                        "attendeeEmail": attendee.and_then(|a| a["email"].as_str()),
                        "attendeeNotes": notes,
                        "meetingUrl": b["meetingUrl"].as_str().or_else(|| b["location"].as_str()),
                    }))
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn calcom() -> Poll {
    let key = need_key(CALCOM_KEY)?;
    let req = client()
        .get("https://api.cal.com/v2/bookings")
        .query(&[("status", "upcoming")])
        .bearer_auth(&key)
        .header("cal-api-version", "2024-08-13");
    let body = fetch(req, "The key cannot read bookings").await?;
    Ok(json!({ "bookings": parse_bookings(&body) }))
}

// ------------------------------------------------------------------ Resend

fn parse_emails(body: &Value) -> (Vec<Value>, Vec<Value>) {
    let all: Vec<Value> = body["data"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|e| {
                    let to = match &e["to"] {
                        Value::Array(a) => a.clone(),
                        Value::String(s) => vec![Value::String(s.clone())],
                        _ => vec![],
                    };
                    Some(json!({
                        "id": e["id"].as_str()?,
                        "to": to,
                        "subject": e["subject"].as_str().unwrap_or(""),
                        "createdAt": e["created_at"].as_str().unwrap_or(""),
                        "lastEvent": e["last_event"].as_str().unwrap_or(""),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();
    let newest = all.iter().take(5).cloned().collect();
    (newest, all)
}

async fn resend() -> Poll {
    let key = need_key(RESEND_KEY)?;
    let req = client().get("https://api.resend.com/emails").query(&[("limit", "100")]).bearer_auth(&key).header("Accept", "application/json");
    let body = fetch(req, "The key cannot read emails (use a full-access key)").await?;
    let (emails, all) = parse_emails(&body);
    // Newest first. The window is the last 100 emails; has_more says there were more than that.
    let times: Vec<&str> = all.iter().filter_map(|e| e["createdAt"].as_str()).collect();
    Ok(json!({
        "emails": emails,
        "count": all.len(),
        "hasMore": body["has_more"].as_bool().unwrap_or(false),
        "createdAt": times,
    }))
}

// ------------------------------------------------------------------ n8n

/// What is known about one execution once its detail has been fetched.
#[derive(Clone)]
struct Detail {
    workflow: String,
    note: Option<String>,
}

fn details() -> &'static Mutex<HashMap<String, Detail>> {
    static DETAILS: OnceLock<Mutex<HashMap<String, Detail>>> = OnceLock::new();
    DETAILS.get_or_init(Default::default)
}

/// `https://host[:port][/prefix]` without a trailing slash; anything else is not an instance.
fn clean_base(raw: &str) -> Option<String> {
    let url = raw.trim().trim_end_matches('/');
    let lower = url.to_ascii_lowercase();
    ((lower.starts_with("https://") || lower.starts_with("http://")) && url.len() > 8 && !url.contains(char::is_whitespace)).then(|| url.to_string())
}

/// The execution list in whichever shape the instance serves: the public API, or the editor's own.
fn executions_of(json: &Value) -> Option<Vec<Value>> {
    match json {
        Value::Array(a) => Some(a.clone()),
        Value::Object(o) => match o.get("data") {
            Some(Value::Array(a)) => Some(a.clone()),
            Some(Value::Object(d)) => d.get("results").and_then(Value::as_array).cloned(),
            _ => None,
        },
        _ => None,
    }
}

fn id_of(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn is_finished(status: &str) -> bool {
    ["success", "error", "crashed", "canceled", "failed"].contains(&status)
}

/// A finished run's headline: the failing node and its message, or where the data ended up.
/// Output values are left out; the pill is always on top of whatever else is on screen.
fn n8n_note(json: &Value, success: bool) -> Option<String> {
    let result = json["data"]["resultData"].as_object()?;
    if !success {
        if let Some(error) = result.get("error") {
            let message = error["message"].as_str().unwrap_or("");
            return Some(match error["node"]["name"].as_str().filter(|n| !n.is_empty()) {
                Some(node) => format!("{node}\n{message}"),
                None => message.to_string(),
            });
        }
        let runs = result.get("runData")?.as_object()?;
        return runs.iter().find_map(|(node, value)| {
            let message = value.as_array()?.first()?["error"]["message"].as_str()?;
            Some(format!("{node}\n{message}"))
        });
    }
    let last = result.get("lastNodeExecuted")?.as_str()?;
    let items = result.get("runData")?.get(last)?.as_array()?.first()?["data"]["main"].as_array()?.first()?.as_array()?;
    Some(format!("{last} · {} item{}", items.len(), if items.len() == 1 { "" } else { "s" }))
}

async fn n8n_detail(base: &str, key: &str, id: &str, success: bool) -> Detail {
    let cache_key = format!("{base}\u{0}{id}");
    if let Some(hit) = details().lock().ok().and_then(|m| m.get(&cache_key).cloned()) {
        return hit;
    }
    let mut found = Detail { workflow: "Workflow".to_string(), note: None };
    let urls = [
        format!("{base}/api/v1/executions/{id}?includeData=true"),
        format!("{base}/api/v1/executions/{id}"),
        format!("{base}/rest/executions/{id}?includeData=true"),
        format!("{base}/rest/executions/{id}"),
    ];
    for url in &urls {
        // A failure here only means no detail; the status code is the whole story.
        let Ok(json) = fetch(client().get(url).header("X-N8N-API-KEY", key).header("Accept", "application/json"), "").await else { continue };
        let body = if json["data"].is_object() && json["data"]["data"].is_object() { &json["data"] } else { &json };
        found.workflow = body["workflowData"]["name"].as_str().or_else(|| body["name"].as_str()).unwrap_or("Workflow").to_string();
        found.note = n8n_note(body, success);
        break;
    }
    if let Ok(mut map) = details().lock() {
        if map.len() > 40 {
            map.clear();
        }
        map.insert(cache_key, found.clone());
    }
    found
}

async fn n8n(options: &Value) -> Poll {
    let key = need_key(N8N_KEY)?;
    let Some(base) = options["url"].as_str().and_then(clean_base) else {
        return Err(Failure::new("config", "Add your n8n instance URL"));
    };

    // The public API first, then the editor's own, as the macOS poller did.
    let mut list = None;
    let mut last_error = None;
    for path in ["/api/v1/executions?limit=5&includeData=false", "/rest/executions?limit=5&includeData=false"] {
        match fetch(client().get(format!("{base}{path}")).header("X-N8N-API-KEY", &key).header("Accept", "application/json"), "The API key was refused").await {
            Ok(json) => {
                list = executions_of(&json);
                if list.is_some() {
                    break;
                }
            }
            Err(f) => last_error = Some(f),
        }
    }
    let Some(list) = list else {
        return Err(last_error.unwrap_or_else(|| Failure::new("http", "Unexpected response")));
    };

    let mut executions: Vec<Value> = list
        .iter()
        .filter_map(|e| {
            let status = e["status"].as_str().unwrap_or(if e["finished"].as_bool() == Some(true) { "success" } else { "running" });
            Some(json!({
                "id": id_of(&e["id"])?,
                "status": status,
                "workflowId": id_of(&e["workflowId"]),
                "startedAt": e["startedAt"].as_str(),
                "stoppedAt": e["stoppedAt"].as_str(),
            }))
        })
        .collect();

    // Name and detail for the newest finished run and the newest failed one (often the same).
    let finished = executions.iter().position(|e| is_finished(e["status"].as_str().unwrap_or("")));
    let failed = executions.iter().position(|e| matches!(e["status"].as_str(), Some("error" | "crashed" | "failed")));
    for i in [finished, failed].into_iter().flatten().collect::<std::collections::BTreeSet<_>>() {
        let id = executions[i]["id"].as_str().unwrap_or("").to_string();
        let success = executions[i]["status"].as_str() == Some("success");
        let d = n8n_detail(&base, &key, &id, success).await;
        executions[i]["workflow"] = json!(d.workflow);
        executions[i]["note"] = json!(d.note);
    }

    Ok(json!({ "executions": executions, "baseUrl": base }))
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watch_list_keeps_only_owner_slash_name() {
        let o = json!({ "repos": ["moss/island", " moss/app ", "nope", "a/b/c", "../x", "ok-1/under_score.v2", "", 5, "x/y", "x/z", "x/w", "x/v"] });
        assert_eq!(watch_list(&o), ["moss/island", "moss/app", "ok-1/under_score.v2", "x/y", "x/z"]);
        assert!(watch_list(&json!({})).is_empty());
    }

    #[test]
    fn github_runs_keep_status_and_conclusion() {
        let body = json!({ "workflow_runs": [
            { "id": 9, "name": "CI", "display_title": "Fix it", "head_branch": "main", "status": "completed", "conclusion": "failure", "html_url": "https://github.com/moss/island/actions/runs/9", "updated_at": "2026-10-01T10:00:00Z" },
            { "id": 10, "status": "in_progress", "conclusion": null, "updated_at": "2026-10-01T10:05:00Z" },
            { "name": "no id" }
        ] });
        let runs = parse_runs(&body, "moss/island");
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0]["conclusion"], "failure");
        assert_eq!(runs[0]["repo"], "moss/island");
        assert!(runs[1]["conclusion"].is_null());
        assert_eq!(runs[1]["name"], "Workflow");
    }

    #[test]
    fn vercel_deployments_keep_every_state_and_the_commit() {
        let body = json!({ "deployments": [
            { "uid": "dpl_1", "name": "site", "url": "site-abc.vercel.app", "inspectorUrl": "https://vercel.com/moss/site/abc", "state": "BUILDING", "createdAt": 1790000000000.0, "meta": { "githubCommitMessage": "Add pricing", "githubCommitRef": "main" } },
            { "uid": "dpl_0", "name": "site", "state": "READY", "createdAt": 1789999000000i64, "target": "production" },
            { "name": "broken" }
        ] });
        let d = parse_deployments(&body);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0]["state"], "BUILDING");
        assert_eq!(d[0]["commit"], "Add pricing");
        assert_eq!(d[0]["branch"], "main");
        assert_eq!(d[1]["target"], "production");
        assert!(d[1]["commit"].is_null());
    }

    #[test]
    fn stripe_balance_sums_one_currency() {
        let body = json!({ "available": [ { "amount": 1000, "currency": "eur" }, { "amount": 50, "currency": "usd" } ], "pending": [ { "amount": 250, "currency": "eur" }, { "amount": 7, "currency": "usd" } ] });
        assert_eq!(parse_balance(&body), (1000, 250, "eur".to_string()));
        assert_eq!(parse_balance(&json!({})), (0, 0, "usd".to_string()));
        // Nothing available yet: the pending bucket names the currency.
        assert_eq!(parse_balance(&json!({ "available": [], "pending": [ { "amount": 5, "currency": "cad" } ] })), (0, 5, "cad".to_string()));
    }

    #[test]
    fn stripe_charges_fall_back_to_the_billing_name() {
        let body = json!({ "data": [
            { "id": "ch_1", "amount": 4900, "currency": "eur", "created": 1790000000, "status": "succeeded", "description": "Pro plan" },
            { "id": "ch_2", "amount": 100, "currency": "usd", "created": 1790000100, "status": "failed", "billing_details": { "name": "Ada" } },
            { "amount": 1 }
        ] });
        let p = parse_charges(&body);
        assert_eq!(p.len(), 2);
        assert_eq!(p[0]["description"], "Pro plan");
        assert_eq!(p[0]["createdAt"], 1790000000000i64);
        assert_eq!(p[1]["description"], "Ada");
        assert_eq!(p[1]["status"], "failed");
    }

    #[test]
    fn notion_titles_come_from_pages_and_databases() {
        let page = json!({ "id": "p1", "object": "page", "last_edited_time": "2026-10-01T09:00:00.000Z", "url": "https://www.notion.so/p1", "icon": { "type": "emoji", "emoji": "📝" },
            "properties": { "Tags": { "type": "multi_select" }, "Name": { "type": "title", "title": [ { "plain_text": "Weekly plan" } ] } } });
        let p = parse_notion_page(&page).unwrap();
        assert_eq!(p["title"], "Weekly plan");
        assert_eq!(p["emoji"], "📝");
        let db = json!({ "id": "d1", "object": "database", "last_edited_time": "2026-10-01T08:00:00.000Z", "title": [ { "plain_text": "Tasks" } ] });
        assert_eq!(parse_notion_page(&db).unwrap()["title"], "Tasks");
        let blank = json!({ "id": "x", "object": "page", "last_edited_time": "t", "properties": {} });
        assert_eq!(parse_notion_page(&blank).unwrap()["title"], "Untitled");
        assert!(parse_notion_page(&json!({ "object": "page" })).is_none());
    }

    #[test]
    fn calcom_bookings_read_both_time_shapes() {
        let body = json!({ "status": "success", "data": [
            { "id": 12, "uid": "abc", "title": "Intro call", "start": "2026-10-02T14:00:00.000Z", "end": "2026-10-02T14:30:00.000Z", "status": "accepted",
              "attendees": [ { "name": "Ada", "email": "ada@example.com" } ], "responses": { "notes": { "value": "Bring the deck" } }, "meetingUrl": "https://app.cal.com/video/xyz" },
            { "id": "13", "startTime": "2026-10-03T09:00:00.000Z" },
            { "title": "no id", "start": "2026-10-03T09:00:00.000Z" }
        ] });
        let b = parse_bookings(&body);
        assert_eq!(b.len(), 2);
        assert_eq!(b[0]["id"], "12");
        assert_eq!(b[0]["attendeeName"], "Ada");
        assert_eq!(b[0]["attendeeNotes"], "Bring the deck");
        assert_eq!(b[0]["meetingUrl"], "https://app.cal.com/video/xyz");
        assert_eq!(b[1]["title"], "Meeting");
        assert_eq!(b[1]["start"], "2026-10-03T09:00:00.000Z");
    }

    #[test]
    fn resend_emails_accept_one_or_many_recipients() {
        let body = json!({ "data": [
            { "id": "e1", "to": ["a@x.com", "b@x.com"], "subject": "Hi", "created_at": "2026-10-01 10:00:00+00", "last_event": "delivered" },
            { "id": "e2", "to": "c@x.com", "last_event": "bounced" },
            { "id": "e3" }, { "id": "e4" }, { "id": "e5" }, { "id": "e6" }
        ] });
        let (newest, all) = parse_emails(&body);
        assert_eq!(all.len(), 6);
        assert_eq!(newest.len(), 5);
        assert_eq!(newest[0]["to"].as_array().unwrap().len(), 2);
        assert_eq!(newest[1]["to"][0], "c@x.com");
        assert_eq!(newest[1]["lastEvent"], "bounced");
    }

    #[test]
    fn n8n_base_urls_are_cleaned() {
        assert_eq!(clean_base(" https://n8n.example.com/ ").as_deref(), Some("https://n8n.example.com"));
        assert_eq!(clean_base("http://localhost:5678").as_deref(), Some("http://localhost:5678"));
        assert_eq!(clean_base("n8n.example.com"), None);
        assert_eq!(clean_base("https://"), None);
        assert_eq!(clean_base("https://a b"), None);
    }

    #[test]
    fn n8n_lists_come_in_three_shapes() {
        let public = json!({ "data": [ { "id": "1" } ], "nextCursor": null });
        let bare = json!([ { "id": 2 } ]);
        let editor = json!({ "data": { "results": [ { "id": 3 } ], "count": 1 } });
        assert_eq!(executions_of(&public).unwrap().len(), 1);
        assert_eq!(executions_of(&bare).unwrap().len(), 1);
        assert_eq!(executions_of(&editor).unwrap().len(), 1);
        assert!(executions_of(&json!({ "message": "nope" })).is_none());
        assert_eq!(id_of(&json!(7)).as_deref(), Some("7"));
        assert_eq!(id_of(&json!("x")).as_deref(), Some("x"));
        assert!(id_of(&json!(null)).is_none());
    }

    #[test]
    fn n8n_notes_name_the_failing_node_and_hide_the_data() {
        let failed = json!({ "data": { "resultData": { "error": { "message": "Bad credentials", "node": { "name": "GitHub" } } } } });
        assert_eq!(n8n_note(&failed, false).as_deref(), Some("GitHub\nBad credentials"));
        let from_runs = json!({ "data": { "resultData": { "runData": { "HTTP Request": [ { "error": { "message": "timeout" } } ] } } } });
        assert_eq!(n8n_note(&from_runs, false).as_deref(), Some("HTTP Request\ntimeout"));
        let ok = json!({ "data": { "resultData": { "lastNodeExecuted": "Set", "runData": { "Set": [ { "data": { "main": [ [ { "json": { "secret": "x" } }, { "json": {} } ] ] } } ] } } } });
        assert_eq!(n8n_note(&ok, true).as_deref(), Some("Set · 2 items"));
        assert!(n8n_note(&json!({}), true).is_none());
    }

    #[test]
    fn statuses_read_like_coucous() {
        let f = status_failure(401, "", None);
        assert_eq!((f.code, f.message.as_str()), ("auth", "Invalid API key (401)"));
        assert_eq!(status_failure(403, "Token lacks the scope it needs", None).message, "Token lacks the scope it needs");
        assert_eq!(status_failure(403, "", None).message, "Access denied (403)");
        let limited = status_failure(429, "", Some(30));
        assert_eq!((limited.code, limited.retry_after), ("limit", Some(30)));
        assert_eq!(status_failure(502, "", None).message, "API error 502");
    }

    #[test]
    fn an_unknown_service_is_a_config_failure() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let r = runtime.block_on(integration_poll("nope".into(), None));
        assert_eq!(r["ok"], false);
        assert_eq!(r["code"], "config");
    }
}
