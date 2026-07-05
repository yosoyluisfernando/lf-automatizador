pub(crate) const MAX_UVOX_PAYLOAD: usize = 16_377;

pub(crate) const AUTHENTICATE: u16 = 0x1001;
pub(crate) const SETUP: u16 = 0x1002;
pub(crate) const NEGOTIATE_BUFFER: u16 = 0x1003;
pub(crate) const STANDBY: u16 = 0x1004;
pub(crate) const TERMINATE: u16 = 0x1005;
pub(crate) const NEGOTIATE_PAYLOAD: u16 = 0x1008;
pub(crate) const REQUEST_CIPHER: u16 = 0x1009;
pub(crate) const SET_MIME: u16 = 0x1040;
pub(crate) const ICY_NAME: u16 = 0x1100;
pub(crate) const ICY_GENRE: u16 = 0x1101;
pub(crate) const ICY_URL: u16 = 0x1102;
pub(crate) const ICY_PUBLIC: u16 = 0x1103;
pub(crate) const MP3_DATA: u16 = 0x7000;
pub(crate) const AAC_LC_DATA: u16 = 0x8001;
pub(crate) const AACP_DATA: u16 = 0x8003;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct UltravoxFrame {
    pub(crate) frame_type: u16,
    pub(crate) payload: Vec<u8>,
    pub(crate) text: String,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct UltravoxParser {
    buffer: Vec<u8>,
}

impl UltravoxParser {
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Vec<UltravoxFrame> {
        if !chunk.is_empty() {
            self.buffer.extend_from_slice(chunk);
        }
        let mut frames = Vec::new();
        while !self.buffer.is_empty() {
            let Some(marker) = self.buffer.iter().position(|byte| *byte == 0x5a) else {
                self.buffer.clear();
                break;
            };
            if marker > 0 {
                self.buffer.drain(..marker);
            }
            if self.buffer.len() < 7 {
                break;
            }
            let length = u16::from_be_bytes([self.buffer[4], self.buffer[5]]) as usize;
            let total = 7 + length;
            if self.buffer.len() < total {
                break;
            }
            if self.buffer[total - 1] != 0 {
                self.buffer.drain(..1);
                continue;
            }
            let payload = self.buffer[6..6 + length].to_vec();
            frames.push(UltravoxFrame {
                frame_type: u16::from_be_bytes([self.buffer[2], self.buffer[3]]),
                text: String::from_utf8_lossy(&payload)
                    .trim_end_matches('\0')
                    .to_string(),
                payload,
            });
            self.buffer.drain(..total);
        }
        frames
    }
}

pub(crate) fn encode_uvox_frame(frame_type: u16, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(7 + payload.len());
    out.push(0x5a);
    out.push(0);
    out.extend_from_slice(&frame_type.to_be_bytes());
    out.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    out.extend_from_slice(payload);
    out.push(0);
    out
}

pub(crate) fn encode_control_frame(frame_type: u16, text: &str) -> Vec<u8> {
    let mut payload = text.as_bytes().to_vec();
    payload.push(0);
    encode_uvox_frame(frame_type, &payload)
}

pub(crate) fn encrypt_xtea_hex(value: &str, key_value: &str) -> String {
    let data = padded_bytes(value.as_bytes(), 8);
    let mut key_bytes = [0u8; 16];
    let source = key_value.as_bytes();
    let len = source.len().min(key_bytes.len());
    key_bytes[..len].copy_from_slice(&source[..len]);
    let key = [
        u32::from_be_bytes(key_bytes[0..4].try_into().unwrap()),
        u32::from_be_bytes(key_bytes[4..8].try_into().unwrap()),
        u32::from_be_bytes(key_bytes[8..12].try_into().unwrap()),
        u32::from_be_bytes(key_bytes[12..16].try_into().unwrap()),
    ];
    let mut encrypted = String::new();
    for block in data.chunks_exact(8) {
        let mut left = u32::from_be_bytes(block[0..4].try_into().unwrap());
        let mut right = u32::from_be_bytes(block[4..8].try_into().unwrap());
        let mut sum = 0u32;
        for _ in 0..32 {
            left = left.wrapping_add(
                ((((right << 4) ^ (right >> 5)).wrapping_add(right))
                    ^ (sum.wrapping_add(key[(sum & 3) as usize]))) as u32,
            );
            sum = sum.wrapping_add(0x9e37_79b9);
            right = right.wrapping_add(
                ((((left << 4) ^ (left >> 5)).wrapping_add(left))
                    ^ (sum.wrapping_add(key[((sum >> 11) & 3) as usize]))) as u32,
            );
        }
        encrypted.push_str(&format!("{:08x}{:08x}", left, right));
    }
    encrypted
}

fn padded_bytes(value: &[u8], block_size: usize) -> Vec<u8> {
    if value.is_empty() {
        return Vec::new();
    }
    let mut out = vec![0u8; value.len().div_ceil(block_size) * block_size];
    out[..value.len()].copy_from_slice(value);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_and_parses_control_frame() {
        let frame = encode_control_frame(REQUEST_CIPHER, "2.1");
        assert_eq!(frame[0], 0x5a);
        let mut parser = UltravoxParser::default();
        let frames = parser.push(&frame);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].frame_type, REQUEST_CIPHER);
        assert_eq!(frames[0].text, "2.1");
    }

    #[test]
    fn xtea_matches_js_vector() {
        assert_eq!(
            encrypt_xtea_hex("source", "0123456789abcdef"),
            "9d0eb5bb6de8e920"
        );
        assert_eq!(
            encrypt_xtea_hex("secret", "0123456789abcdef"),
            "ef7c64d677240e19"
        );
    }
}
