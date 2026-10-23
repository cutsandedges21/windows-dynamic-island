// The phone remote's own iroh endpoint: the same relay settings as Land anywhere's
// (src/anywhere.rs), its own key, and one protocol, `island-phone/1`. With n0's relays it also
// publishes where it is, so a phone finds it by key alone when its relay changes.

use std::sync::Weak;

use iroh::endpoint::presets;
use iroh::{Endpoint, SecretKey};

use super::*;

/// A phone gets this long to finish the QUIC/TLS handshake.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

pub(super) async fn bind(key: SecretKey, relays: &Relays) -> Result<Endpoint, String> {
    let builder = match relays {
        #[cfg(test)]
        Relays::Off => Endpoint::builder(presets::Minimal).relay_mode(iroh::RelayMode::Disabled),
        Relays::N0 => Endpoint::builder(presets::N0),
        #[cfg(test)]
        Relays::N0RelayOnly => Endpoint::builder(presets::N0).clear_ip_transports(),
        #[cfg(test)]
        Relays::Local(map) => Endpoint::builder(presets::Minimal)
            .relay_mode(iroh::RelayMode::Custom(map.clone()))
            .ca_tls_config(iroh::tls::CaTlsConfig::insecure_skip_verify())
            .clear_ip_transports(),
    };
    builder.secret_key(key).alpns(vec![ALPN.to_vec()]).bind().await.map_err(|e| format!("Island can't reach phones: {e}"))
}

/// Takes every connection that finishes its handshake (the session decides who stays). Ends when
/// the endpoint closes.
pub(super) async fn accept_loop(ep: Endpoint, remote: Weak<Remote>) {
    while let Some(incoming) = ep.accept().await {
        let Some(remote) = remote.upgrade() else { break };
        tokio::spawn(async move {
            let Ok(accepting) = incoming.accept() else { return };
            let Ok(Ok(conn)) = timeout(HANDSHAKE_TIMEOUT, accepting).await else { return };
            remote.incoming(conn).await;
        });
    }
}

/// The relays a phone dials this endpoint through: its home relay, else n0's (browser form).
pub(super) fn browser_relays(ep: &Endpoint) -> Vec<String> {
    let home: Vec<String> = ep.addr().relay_urls().filter_map(pair::browser_relay).collect();
    if !home.is_empty() {
        return home;
    }
    iroh::defaults::prod::default_relay_map().urls::<Vec<iroh::RelayUrl>>().iter().filter_map(pair::browser_relay).collect()
}
