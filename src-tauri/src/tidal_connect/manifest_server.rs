use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::RwLock;

/// Tiny local HTTP endpoint that serves the current TIDAL DASH manifest so
/// the receiver can pull it over the LAN by plain URL. Segment URLs inside
/// TIDAL manifests are absolute (`audio.tidal.com`), so the only body we
/// ever serve is the manifest itself and the receiver fetches the segments
/// straight from the CDN.
///
/// The listener binds once on an ephemeral port and serves whatever manifest
/// `set()` stores at the time of the request; it lives for the process
/// lifetime.
pub struct ManifestServer {
    inner: Arc<Inner>,
}

struct Inner {
    base_url: RwLock<Option<String>>,
    body: RwLock<Vec<u8>>,
}

impl Default for ManifestServer {
    fn default() -> Self {
        Self::new()
    }
}

impl ManifestServer {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                base_url: RwLock::new(None),
                body: RwLock::new(Vec::new()),
            }),
        }
    }

    /// Bind the endpoint once and start the accept loop. Later calls are
    /// no-ops while the first listener is alive. Returns the pathless base
    /// URL (`http://<local-lan-ip>:<port>`); callers append the served path.
    pub async fn ensure_started(&self, receiver_ip: &str) -> Result<String, String> {
        if let Some(base) = self.inner.base_url.read().await.clone() {
            return Ok(base);
        }
        let listener = TcpListener::bind("0.0.0.0:0")
            .await
            .map_err(|e| format!("manifest server bind failed: {}", e))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("manifest server local_addr failed: {}", e))?
            .port();

        // Derive our LAN address as seen on the path to the receiver via a
        // UDP connect probe (no packet is sent; connect disallowed: route
        // lookup only).
        let local_ip = udp_probe_ip(receiver_ip)
            .or_else(|| udp_probe_ip("8.8.8.8"))
            .unwrap_or_else(|| "127.0.0.1".to_string());

        let base = format!("http://{}:{}", local_ip, port);
        *self.inner.base_url.write().await = Some(base.clone());

        let inner = Arc::clone(&self.inner);
        tokio::spawn(async move {
            loop {
                let (mut stream, _) = match listener.accept().await {
                    Ok(pair) => pair,
                    Err(_) => continue,
                };
                let inner = Arc::clone(&inner);
                tokio::spawn(async move {
                    let mut buf = [0u8; 2048];
                    let _ = stream.read(&mut buf).await;
                    let body = inner.body.read().await.clone();
                    if body.is_empty() {
                        let _ = stream
                            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                            .await;
                        return;
                    }
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/dash+xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(head.as_bytes()).await;
                    let _ = stream.write_all(&body).await;
                    let _ = stream.flush().await;
                });
            }
        });
        Ok(base)
    }

    /// Install the manifest to serve on the next request.
    pub async fn set(&self, manifest_xml: &str) -> Result<String, String> {
        // The base URL needs the receiver's LAN segment; it is set by the
        // first ensure_started() call. If not started yet, fall back to
        // binding now with a syntactically simple receiver address.
        let base = {
            let guard = self.inner.base_url.read().await;
            guard.clone()
        };
        match base {
            Some(b) => {
                *self.inner.body.write().await = manifest_xml.as_bytes().to_vec();
                Ok(b)
            }
            None => Err("manifest server not started".into()),
        }
    }

}

fn udp_probe_ip(dst: &str) -> Option<String> {
    match std::net::UdpSocket::bind("0.0.0.0:0") {
        Ok(sock) => {
            if sock.connect((dst, 53)).is_ok() {
                sock.local_addr().ok().map(|a| a.ip().to_string())
            } else {
                None
            }
        }
        Err(_) => None,
    }
}
