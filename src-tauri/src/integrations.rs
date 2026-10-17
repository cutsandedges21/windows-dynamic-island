// Service pollers for the integration activities (GitHub, Vercel, Notion).
// `integration_poll` asks one service for a fresh snapshot
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
const NOTION_TOKEN: &str = "notion.token";

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
        "notion" => notion().await,
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
