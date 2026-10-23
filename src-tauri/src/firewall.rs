// Whether Windows Firewall lets Land hear the network it is on, and the fix.
//
// Windows' "allow this app" prompt ticks Private networks only. Leaving Public unticked
// makes an Allow rule for Private and a Block rule for Public, and a Block rule wins. School,
// café and most work Wi-Fi is Public, so there the other computers can't find this one, and
// nothing says why. `land_firewall` reads the rules (no admin needed); `land_firewall_fix`
// asks Windows (UAC) once to drop Island's inbound rules and allow it on every network.

// The helpers below only run on Windows; a Mac build still compiles them for the tests.
#![cfg_attr(not(windows), allow(dead_code))]

use serde::Serialize;

pub const DOMAIN: i32 = 1;
pub const PRIVATE: i32 = 2;
pub const PUBLIC: i32 = 4;

/// One inbound rule about this program, as far as the verdict needs it.
#[derive(Clone, Debug, PartialEq)]
pub struct Rule {
    pub allow: bool,
    pub enabled: bool,
    /// Profile bits it covers (DOMAIN | PRIVATE | PUBLIC; all bits = every network).
    pub profiles: i32,
}

/// One network profile in use now, and how the firewall is set for it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Profile {
    pub bit: i32,
    pub on: bool,
    /// "Block all incoming connections, including those in the list of allowed apps".
    pub block_all: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    /// "ok", "blocked" (fixable), "block-all" (the user's own setting; Island leaves it),
    /// or "unknown" (couldn't read the firewall; say nothing).
    pub state: String,
    /// The network kind it is about: "public", "private" or "domain".
    pub network: String,
}

impl Verdict {
    fn new(state: &str, bit: i32) -> Self {
        Self { state: state.into(), network: profile_name(bit).into() }
    }
}

pub fn profile_name(bit: i32) -> &'static str {
    match bit {
        PUBLIC => "public",
        PRIVATE => "private",
        DOMAIN => "domain",
        _ => "",
    }
}

/// For each profile in use with the firewall on: a Block rule for this program on it, or no
/// Allow rule on it, means Island can't be reached there. The first such profile is reported,
/// Public before the others (the usual one).
pub fn verdict(current: &[Profile], rules: &[Rule]) -> Verdict {
    let mut order: Vec<&Profile> = current.iter().filter(|p| p.on).collect();
    order.sort_by_key(|p| if p.bit == PUBLIC { 0 } else { 1 });
    for p in order {
        if p.block_all {
            return Verdict::new("block-all", p.bit);
        }
        let covers = |r: &&Rule| r.enabled && r.profiles & p.bit != 0;
        let blocked = rules.iter().filter(covers).any(|r| !r.allow);
        let allowed = rules.iter().filter(covers).any(|r| r.allow);
        if blocked || !allowed {
            return Verdict::new("blocked", p.bit);
        }
    }
    Verdict { state: "ok".into(), network: String::new() }
}

/// The same path as Windows writes it into a rule: case and slashes don't matter.
pub fn same_program(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.trim().trim_matches('"').replace('/', "\\").to_lowercase();
    !a.is_empty() && norm(a) == norm(b)
}

/// The elevated command: remove every inbound rule for this program, then allow it on every
/// network. `cmd /s /c "…"` keeps the quotes around a path with spaces.
pub fn fix_command(exe: &str) -> String {
    format!(
        "/s /c \"netsh advfirewall firewall delete rule name=all dir=in program=\"{exe}\" & netsh advfirewall firewall add rule name=\"Island\" dir=in action=allow program=\"{exe}\" profile=any enable=yes\""
    )
}

#[cfg(windows)]
mod win {
    use super::*;
    use windows::core::{Interface, BSTR, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, VARIANT_TRUE};
    use windows::Win32::NetworkManagement::WindowsFirewall::{INetFwPolicy2, INetFwRule, NetFwPolicy2, NET_FW_ACTION_ALLOW, NET_FW_PROFILE_TYPE2, NET_FW_RULE_DIR_IN};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, IDispatch, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use windows::Win32::System::Ole::IEnumVARIANT;
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
    use windows::Win32::System::Variant::{VariantClear, VARIANT, VT_DISPATCH};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn read(exe: &str) -> windows::core::Result<(Vec<Profile>, Vec<Rule>)> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let policy: INetFwPolicy2 = CoCreateInstance(&NetFwPolicy2, None, CLSCTX_INPROC_SERVER)?;
            let current = policy.CurrentProfileTypes()?;
            let mut profiles = Vec::new();
            for bit in [DOMAIN, PRIVATE, PUBLIC] {
                if current & bit != 0 {
                    let t = NET_FW_PROFILE_TYPE2(bit);
                    let on = policy.get_FirewallEnabled(t)? == VARIANT_TRUE;
                    let block_all = policy.get_BlockAllInboundTraffic(t)? == VARIANT_TRUE;
                    profiles.push(Profile { bit, on, block_all });
                }
            }
            let list: IEnumVARIANT = policy.Rules()?._NewEnum()?.cast()?;
            let mut rules = Vec::new();
            loop {
                let mut v = [VARIANT::default()];
                let mut got = 0u32;
                if list.Next(&mut v, &mut got).is_err() || got == 0 {
                    break;
                }
                let inner = &v[0].Anonymous.Anonymous;
                let disp: Option<IDispatch> = if inner.vt == VT_DISPATCH { (*inner.Anonymous.pdispVal).clone() } else { None };
                let _ = VariantClear(&mut v[0]);
                let Some(rule) = disp.and_then(|d| d.cast::<INetFwRule>().ok()) else { continue };
                if rule.Direction().ok() != Some(NET_FW_RULE_DIR_IN) {
                    continue;
                }
                let app: BSTR = rule.ApplicationName().unwrap_or_default();
                if !same_program(&app.to_string(), exe) {
                    continue;
                }
                rules.push(Rule {
                    allow: rule.Action().ok() == Some(NET_FW_ACTION_ALLOW),
                    enabled: rule.Enabled().map(|e| e == VARIANT_TRUE).unwrap_or(false),
                    profiles: rule.Profiles().unwrap_or(0),
                });
            }
            Ok((profiles, rules))
        }
    }

    /// Runs the fix as administrator; Ok once it finished well.
    pub fn fix(exe: &str) -> Result<(), String> {
        let (verb, file, params) = (wide("runas"), wide("cmd.exe"), wide(&fix_command(exe)));
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS,
            lpVerb: PCWSTR(verb.as_ptr()),
            lpFile: PCWSTR(file.as_ptr()),
            lpParameters: PCWSTR(params.as_ptr()),
            nShow: SW_HIDE.0,
            ..Default::default()
        };
        unsafe {
            if ShellExecuteExW(&mut info).is_err() {
                return Err("Windows didn't allow it (the prompt was cancelled).".into());
            }
            let _ = WaitForSingleObject(info.hProcess, 30_000);
            let mut code = 1u32;
            let _ = GetExitCodeProcess(info.hProcess, &mut code);
            let _ = CloseHandle(info.hProcess);
            crate::log::line(format!("land: firewall fix exited {code}"));
            if code == 0 {
                Ok(())
            } else {
                Err(format!("Windows said no (code {code})."))
            }
        }
    }
}

fn exe() -> String {
    std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

#[cfg(windows)]
fn check() -> Verdict {
    match win::read(&exe()) {
        Ok((profiles, rules)) => verdict(&profiles, &rules),
        Err(e) => {
            crate::log::line(format!("land: firewall unreadable: {e}"));
            Verdict { state: "unknown".into(), network: String::new() }
        }
    }
}

#[cfg(not(windows))]
fn check() -> Verdict {
    Verdict { state: "ok".into(), network: String::new() }
}

/// Whether other computers on this network can reach Island.
#[tauri::command]
pub async fn land_firewall() -> Verdict {
    tauri::async_runtime::spawn_blocking(check).await.unwrap_or(Verdict { state: "unknown".into(), network: String::new() })
}

/// Lets Island through on every network (one UAC prompt); returns the new verdict.
#[tauri::command]
pub async fn land_firewall_fix() -> Result<Verdict, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(|| {
            win::fix(&exe())?;
            Ok(check())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        Ok(check())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: i32 = 0x7fff_ffff;

    fn public() -> Vec<Profile> {
        vec![Profile { bit: PUBLIC, on: true, block_all: false }]
    }

    fn rule(allow: bool, profiles: i32) -> Rule {
        Rule { allow, enabled: true, profiles }
    }

    #[test]
    fn the_prompt_with_only_private_ticked_blocks_public_wifi() {
        // What Windows writes: Allow on Private, Block on Public.
        let rules = [rule(true, PRIVATE), rule(false, PUBLIC)];
        assert_eq!(verdict(&public(), &rules), Verdict { state: "blocked".into(), network: "public".into() });
        let home = [Profile { bit: PRIVATE, on: true, block_all: false }];
        assert_eq!(verdict(&home, &rules).state, "ok");
    }

    #[test]
    fn a_block_rule_wins_over_an_allow_rule() {
        assert_eq!(verdict(&public(), &[rule(true, ALL), rule(false, PUBLIC)]).state, "blocked");
    }

    #[test]
    fn allowed_everywhere_is_ok_and_disabled_rules_dont_count() {
        assert_eq!(verdict(&public(), &[rule(true, ALL)]).state, "ok");
        let off = Rule { allow: false, enabled: false, profiles: ALL };
        assert_eq!(verdict(&public(), &[rule(true, ALL), off.clone()]).state, "ok");
        assert_eq!(verdict(&public(), &[off]).state, "blocked");
    }

    #[test]
    fn no_rule_at_all_is_blocked_and_a_firewall_off_is_ok() {
        assert_eq!(verdict(&public(), &[]).state, "blocked");
        assert_eq!(verdict(&[Profile { bit: PUBLIC, on: false, block_all: false }], &[]).state, "ok");
    }

    #[test]
    fn block_all_is_the_users_own_setting() {
        let p = [Profile { bit: PUBLIC, on: true, block_all: true }];
        assert_eq!(verdict(&p, &[rule(true, ALL)]).state, "block-all");
    }

    #[test]
    fn public_is_reported_first() {
        let both = [Profile { bit: DOMAIN, on: true, block_all: false }, Profile { bit: PUBLIC, on: true, block_all: false }];
        assert_eq!(verdict(&both, &[]).network, "public");
    }

    #[test]
    fn program_paths_match_like_windows_does() {
        assert!(same_program("C:\\Users\\Me\\Island.exe", "c:\\users\\me\\island.exe"));
        assert!(same_program("\"C:/Users/Me/Island.exe\"", "c:\\users\\me\\island.exe"));
        assert!(!same_program("", "c:\\island.exe"));
        assert!(!same_program("c:\\other.exe", "c:\\island.exe"));
    }

    #[test]
    fn the_fix_quotes_a_path_with_spaces() {
        let c = fix_command("C:\\Program Files\\Island\\Island.exe");
        assert!(c.starts_with("/s /c \"netsh"));
        assert!(c.contains("program=\"C:\\Program Files\\Island\\Island.exe\" & netsh"));
        assert!(c.ends_with("profile=any enable=yes\""));
    }
}

#[cfg(all(test, windows))]
mod real {
    #[test]
    #[ignore]
    fn reads_this_pcs_firewall() {
        let exe = std::env::var("ISLAND_EXE").unwrap();
        let (p, r) = super::win::read(&exe).unwrap();
        println!("profiles {p:?}\nrules {r:?}\nverdict {:?}", super::verdict(&p, &r));
    }
}
