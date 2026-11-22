//! Byte encodings used by the protocol: RFC 4648 base32 (lowercase, no padding),
//! base64url (no padding), hex, and RFC 9285 base45 (animated QR frames, spec §11.2). Mirrors `sdk/js/src/protocol/encoding.ts`.

use crate::Error;

const B32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// RFC 4648 base32, lowercase, no padding.
pub fn base32_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let mut value: u32 = 0;
    let mut bits = 0u32;
    for &b in bytes {
        value = (value << 8) | u32::from(b);
        bits += 8;
        while bits >= 5 {
            out.push(B32[((value >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
        value &= (1 << bits) - 1;
    }
    if bits > 0 {
        out.push(B32[((value << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// Decodes base32 (case-insensitive, trailing `=` padding tolerated).
pub fn base32_decode(s: &str) -> Result<Vec<u8>, Error> {
    let s = s.trim_end_matches('=');
    let mut out = Vec::with_capacity(s.len() * 5 / 8);
    let mut value: u32 = 0;
    let mut bits = 0u32;
    for ch in s.bytes() {
        let c = ch.to_ascii_lowercase();
        let i = B32
            .iter()
            .position(|&x| x == c)
            .ok_or_else(|| Error::Encoding(format!("invalid base32 character: {}", ch as char)))?;
        value = (value << 5) | i as u32;
        bits += 5;
        if bits >= 8 {
            out.push(((value >> (bits - 8)) & 255) as u8);
            bits -= 8;
        }
        value &= (1 << bits) - 1;
    }
    Ok(out)
}

/// base64url without padding.
pub fn base64url_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        let chars = chunk.len() + 1;
        for i in 0..chars {
            out.push(B64[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

/// Decodes base64url or standard base64, with or without padding.
pub fn base64url_decode(s: &str) -> Result<Vec<u8>, Error> {
    let s = s.trim_end_matches('=');
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut value: u32 = 0;
    let mut bits = 0u32;
    for ch in s.bytes() {
        let i = match ch {
            b'A'..=b'Z' => ch - b'A',
            b'a'..=b'z' => ch - b'a' + 26,
            b'0'..=b'9' => ch - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            _ => return Err(Error::Encoding(format!("invalid base64 character: {}", ch as char))),
        };
        value = (value << 6) | u32::from(i);
        bits += 6;
        if bits >= 8 {
            out.push(((value >> (bits - 8)) & 255) as u8);
            bits -= 8;
        }
        value &= (1 << bits) - 1;
    }
    Ok(out)
}

/// Lowercase hex.
pub fn hex_encode(bytes: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(H[(b >> 4) as usize] as char);
        s.push(H[(b & 15) as usize] as char);
    }
    s
}

pub fn hex_decode(hex: &str) -> Result<Vec<u8>, Error> {
    if !hex.len().is_multiple_of(2) {
        return Err(Error::Encoding("odd hex length".into()));
    }
    let nib = |c: u8| -> Result<u8, Error> {
        match c {
            b'0'..=b'9' => Ok(c - b'0'),
            b'a'..=b'f' => Ok(c - b'a' + 10),
            b'A'..=b'F' => Ok(c - b'A' + 10),
            _ => Err(Error::Encoding(format!("invalid hex character: {}", c as char))),
        }
    };
    hex.as_bytes()
        .chunks(2)
        .map(|p| Ok((nib(p[0])? << 4) | nib(p[1])?))
        .collect()
}

const B45: &[u8; 45] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

/// RFC 9285 base45 (QR alphanumeric-mode text).
pub fn base45_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(2) * 3);
    for pair in bytes.chunks(2) {
        let (mut n, digits) = match pair {
            [a, b] => (u32::from(*a) * 256 + u32::from(*b), 3),
            [a] => (u32::from(*a), 2),
            _ => unreachable!(),
        };
        for _ in 0..digits {
            out.push(B45[(n % 45) as usize] as char);
            n /= 45;
        }
    }
    out
}

/// Decodes RFC 9285 base45 (upper case only, as the alphabet requires).
pub fn base45_decode(s: &str) -> Result<Vec<u8>, Error> {
    if s.len() % 3 == 1 {
        return Err(Error::Encoding("invalid base45 length".into()));
    }
    let val = |c: u8| -> Result<u32, Error> {
        B45.iter()
            .position(|&x| x == c)
            .map(|p| p as u32)
            .ok_or_else(|| Error::Encoding(format!("invalid base45 character: {}", c as char)))
    };
    let mut out = Vec::with_capacity(s.len() / 3 * 2 + 1);
    for group in s.as_bytes().chunks(3) {
        match group {
            [a, b, c] => {
                let n = val(*a)? + val(*b)? * 45 + val(*c)? * 2025;
                if n > 0xFFFF {
                    return Err(Error::Encoding("invalid base45 triple".into()));
                }
                out.extend_from_slice(&(n as u16).to_be_bytes());
            }
            [a, b] => {
                let n = val(*a)? + val(*b)? * 45;
                if n > 0xFF {
                    return Err(Error::Encoding("invalid base45 pair".into()));
                }
                out.push(n as u8);
            }
            _ => unreachable!(),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base45_rfc9285() {
        for (plain, enc) in [("AB", "BB8"), ("Hello!!", "%69 VD92EX0"), ("base-45", "UJCLQE7W581"), ("ietf!", "QED8WEX0"), ("", "")] {
            assert_eq!(base45_encode(plain.as_bytes()), enc);
            assert_eq!(base45_decode(enc).unwrap(), plain.as_bytes());
        }
        assert!(base45_decode("GGW").is_err());
        assert!(base45_decode("a").is_err());
        assert!(base45_decode("abc").is_err());
    }

    #[test]
    fn base32_rfc4648_vectors() {
        let cases = [
            ("", ""),
            ("f", "my"),
            ("fo", "mzxq"),
            ("foo", "mzxw6"),
            ("foob", "mzxw6yq"),
            ("fooba", "mzxw6ytb"),
            ("foobar", "mzxw6ytboi"),
        ];
        for (plain, enc) in cases {
            assert_eq!(base32_encode(plain.as_bytes()), enc);
            assert_eq!(base32_decode(enc).unwrap(), plain.as_bytes());
            assert_eq!(base32_decode(&enc.to_uppercase()).unwrap(), plain.as_bytes());
        }
        assert!(base32_decode("ab1").is_err());
    }

    #[test]
    fn base64url_vectors() {
        let cases = [
            ("", ""),
            ("f", "Zg"),
            ("fo", "Zm8"),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg"),
            ("fooba", "Zm9vYmE"),
            ("foobar", "Zm9vYmFy"),
        ];
        for (plain, enc) in cases {
            assert_eq!(base64url_encode(plain.as_bytes()), enc);
            assert_eq!(base64url_decode(enc).unwrap(), plain.as_bytes());
        }
        assert_eq!(base64url_encode(&[0xfb, 0xff]), "-_8");
        assert_eq!(base64url_decode("+/8=").unwrap(), vec![0xfb, 0xff]);
        assert!(base64url_decode("a*b").is_err());
    }

    #[test]
    fn base_roundtrip_all_lengths() {
        let data: Vec<u8> = (0..=255u8).collect();
        for n in 0..64 {
            let d = &data[..n];
            assert_eq!(base32_decode(&base32_encode(d)).unwrap(), d);
            assert_eq!(base64url_decode(&base64url_encode(d)).unwrap(), d);
            assert_eq!(hex_decode(&hex_encode(d)).unwrap(), d);
        }
        assert!(hex_decode("abc").is_err());
        assert!(hex_decode("zz").is_err());
    }
}
