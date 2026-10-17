use std::io::{self, Error, ErrorKind};
use serde_json::Value;

/// Tisoc Protocol Framing Envelope
/// 0xFF 0x02 [LEN_H] [LEN_L] [JSON payload...] 0xFF 0x03
pub struct TisocFrame;

impl TisocFrame {
    pub const START_MAGIC: [u8; 2] = [0xFF, 0x02];
    pub const END_MAGIC: [u8; 2] = [0xFF, 0x03];

    /// Encode a JSON Value into a framed tisoc byte vector
    pub fn encode(json: &Value) -> io::Result<Vec<u8>> {
        let payload = serde_json::to_vec(json)
            .map_err(|e| Error::new(ErrorKind::InvalidData, e.to_string()))?;
        
        let len = payload.len();
        if len > u16::MAX as usize {
            return Err(Error::new(ErrorKind::InvalidInput, "Tisoc payload exceeds u16"));
        }

        let mut buf = Vec::with_capacity(len + 6);
        buf.extend_from_slice(&Self::START_MAGIC);
        buf.push(((len >> 8) & 0xFF) as u8);
        buf.push((len & 0xFF) as u8);
        buf.extend_from_slice(&payload);
        buf.extend_from_slice(&Self::END_MAGIC);

        Ok(buf)
    }

    /// Try decoding a frame from a slice, returning (ParsedValue, ConsumedBytes)
    pub fn decode(buf: &[u8]) -> io::Result<Option<(Value, usize)>> {
        if buf.len() < 6 {
            return Ok(None);
        }

        // Search for start magic
        let start_pos = match buf.windows(2).position(|w| w == Self::START_MAGIC) {
            Some(pos) => pos,
            None => return Ok(None),
        };

        if buf.len() < start_pos + 4 {
            return Ok(None);
        }

        let len_h = buf[start_pos + 2] as usize;
        let len_l = buf[start_pos + 3] as usize;
        let payload_len = (len_h << 8) | len_l;

        let total_frame_len = start_pos + 4 + payload_len + 2;
        if buf.len() < total_frame_len {
            return Ok(None);
        }

        let trailer = &buf[start_pos + 4 + payload_len..total_frame_len];
        if trailer != Self::END_MAGIC {
            return Err(Error::new(ErrorKind::InvalidData, "Invalid tisoc trailer magic"));
        }

        let payload_bytes = &buf[start_pos + 4..start_pos + 4 + payload_len];
        let val: Value = serde_json::from_slice(payload_bytes)
            .map_err(|e| Error::new(ErrorKind::InvalidData, e.to_string()))?;

        Ok(Some((val, total_frame_len)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_tisoc_encode_decode() {
        let original = json!({
            "command": "play",
            "requestId": 42
        });

        let encoded = TisocFrame::encode(&original).expect("encode succeeds");
        assert_eq!(&encoded[0..2], &[0xFF, 0x02]);
        assert_eq!(&encoded[encoded.len() - 2..], &[0xFF, 0x03]);

        let (decoded, consumed) = TisocFrame::decode(&encoded)
            .expect("decode succeeds")
            .expect("complete frame");

        assert_eq!(decoded, original);
        assert_eq!(consumed, encoded.len());
    }
}
