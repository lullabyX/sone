use aes_gcm::aead::{Aead, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, KeyInit};
use std::fs;
use std::path::Path;
use zeroize::Zeroize;

use crate::SoneError;

const MAGIC: &[u8; 4] = b"SONE";
const VERSION: u8 = 1;
/// 4 (magic) + 1 (version) + 12 (nonce) = 17 bytes header before ciphertext.
const HEADER_LEN: usize = 4 + 1 + 12;

pub struct Crypto {
    cipher: Aes256Gcm,
}

impl Crypto {
    /// Load or generate the master key and construct the cipher.
    ///
    /// Key sources (in order):
    /// 1. OS keyring (service "sone", entry "master-key")
    /// 2. File fallback at `config_dir/sone.key` (created with 0600 perms)
    pub fn new(config_dir: &Path) -> Result<Self, SoneError> {
        let mut raw_key = load_or_generate_key(config_dir)?;
        let key = aes_gcm::Key::<Aes256Gcm>::from_slice(&raw_key);
        let cipher = Aes256Gcm::new(key);
        raw_key.zeroize();
        Ok(Self { cipher })
    }

    /// Encrypt plaintext. Returns `[magic][version][nonce][ciphertext+tag]`.
    pub fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, SoneError> {
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = self
            .cipher
            .encrypt(&nonce, plaintext)
            .map_err(|e| SoneError::Crypto(e.to_string()))?;

        let mut out = Vec::with_capacity(HEADER_LEN + ciphertext.len());
        out.extend_from_slice(MAGIC);
        out.push(VERSION);
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ciphertext);
        Ok(out)
    }

    /// Decrypt data. If the magic header is absent, the data is assumed to be
    /// unencrypted plaintext (transparent migration) and returned as-is.
    pub fn decrypt(&self, data: &[u8]) -> Result<Vec<u8>, SoneError> {
        if !is_encrypted(data) {
            return Ok(data.to_vec());
        }

        if data.len() < HEADER_LEN {
            return Err(SoneError::Crypto("encrypted data too short".into()));
        }

        let _version = data[4];
        let nonce = aes_gcm::Nonce::from_slice(&data[5..17]);
        let ciphertext = &data[HEADER_LEN..];

        self.cipher
            .decrypt(nonce, ciphertext)
            .map_err(|e| SoneError::Crypto(e.to_string()))
    }
}

/// Check whether the data starts with the SONE magic header.
pub fn is_encrypted(data: &[u8]) -> bool {
    data.len() >= 4 && &data[..4] == MAGIC
}

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

fn load_or_generate_key(config_dir: &Path) -> Result<[u8; 32], SoneError> {
    // 1. Try OS keyring
    match load_key_from_keyring() {
        Ok(key) => return Ok(key),
        Err(e) => log::debug!("Keyring load failed (will try file): {e}"),
    }

    // 2. Try file fallback
    let key_path = config_dir.join("sone.key");
    if let Ok(key) = load_key_from_file(&key_path) {
        // Also try to store in keyring for next time
        if let Err(e) = store_key_in_keyring(&key) {
            log::debug!("Could not store key in keyring: {e}");
        }
        return Ok(key);
    }

    // 3. Generate new key
    log::info!("Generating new encryption master key");
    let mut key = [0u8; 32];
    aes_gcm::aead::OsRng.fill_bytes(&mut key);

    // Always write file backup — keyring may be unreachable on next launch
    // (e.g. AppImage with different D-Bus session)
    store_key_in_file(&key_path, &key)?;

    match store_key_in_keyring(&key) {
        Ok(()) => log::info!("Master key stored in OS keyring + file backup"),
        Err(e) => log::info!("Keyring unavailable ({e}), using file-based key"),
    }

    Ok(key)
}

fn load_key_from_keyring() -> Result<[u8; 32], String> {
    let entry = keyring::Entry::new("sone", "master-key").map_err(|e| e.to_string())?;
    let secret = entry.get_secret().map_err(|e| e.to_string())?;
    if secret.len() != 32 {
        return Err(format!("keyring key wrong length: {}", secret.len()));
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&secret);
    Ok(key)
}

fn store_key_in_keyring(key: &[u8; 32]) -> Result<(), String> {
    let entry = keyring::Entry::new("sone", "master-key").map_err(|e| e.to_string())?;
    entry.set_secret(key).map_err(|e| e.to_string())
}

fn load_key_from_file(path: &Path) -> Result<[u8; 32], SoneError> {
    let data = fs::read(path)?;
    if data.len() != 32 {
        return Err(SoneError::Crypto(format!(
            "key file wrong length: {}",
            data.len()
        )));
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&data);
    Ok(key)
}

fn store_key_in_file(path: &Path, key: &[u8; 32]) -> Result<(), SoneError> {
    fs::write(path, key)?;

    // Set 0600 permissions on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }

    let path_display = path.display();
    log::info!("Master key stored at {path_display} (mode 0600)");
    Ok(())
}

// Use rand's fill_bytes via the aead OsRng re-export
use aes_gcm::aead::rand_core::RngCore;
