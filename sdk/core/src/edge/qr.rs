//! Fountain-coded framing for animated QR (display → camera, air-gapped).
//!
//! The payload is split into `K` source blocks and sent as an endless stream of frames using
//! a systematic LT code with the robust soliton distribution: frames `0..K` carry the source
//! blocks themselves, later frames carry the XOR of a pseudo-random subset. A receiver that
//! joins late or misses frames just keeps scanning until it has enough of them, from any
//! subset, then a peeling (belief-propagation) decoder rebuilds the payload. Rendering frames
//! as QR codes is out of scope; frames are plain byte strings (encode them as QR binary mode
//! or base45/base64 text).
//!
//! Frame layout (big-endian):
//!
//! ```text
//! 0   u8   version (1)
//! 1   u32  payload length
//! 5   u16  block size B
//! 7   u32  CRC-32 of the payload (transfer id and final integrity check)
//! 11  u32  frame sequence number
//! 15  B    XOR of the frame's source blocks (last block zero-padded)
//! ```
//!
//! Block selection for sequence `s` (all implementations must match):
//! `s < K` → `{s}`. Otherwise seed SplitMix64 with `s as u64 ^ (crc as u64) << 32`, draw
//! `u = next_f64()`, take the smallest degree `d` with `u < CDF(d)` (robust soliton, `c = 0.1`,
//! `δ = 0.5`), then pick `d` distinct blocks by a partial Fisher–Yates shuffle of `0..K` using
//! `below(K - i)` for position `i`.

use std::collections::BTreeSet;

use crate::crc::crc32;
use crate::random::SplitMix64;

pub const VERSION: u8 = 1;
pub const HEADER_LEN: usize = 15;
const SOLITON_C: f64 = 0.1;
const SOLITON_DELTA: f64 = 0.5;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum QrError {
    #[error("frame size must exceed the {HEADER_LEN}-byte header and fit in u16")]
    BadFrameSize,
    #[error("payload too large")]
    TooLarge,
    #[error("malformed frame")]
    Malformed,
    #[error("unsupported frame version {0}")]
    Version(u8),
    #[error("frame belongs to a different transfer")]
    Mismatch,
}

/// Robust soliton CDF for `k` blocks; `cdf[d-1] = P(degree <= d)`.
pub fn robust_soliton_cdf(k: usize) -> Vec<f64> {
    let kf = k as f64;
    let r = SOLITON_C * (kf / SOLITON_DELTA).ln() * kf.sqrt();
    let spike = if r > 0.0 { ((kf / r).floor() as usize).clamp(1, k) } else { k };
    let mut mu: Vec<f64> = (1..=k)
        .map(|i| {
            let rho = if i == 1 { 1.0 / kf } else { 1.0 / (i as f64 * (i as f64 - 1.0)) };
            let tau = if r <= 0.0 {
                0.0
            } else if i < spike {
                r / (i as f64 * kf)
            } else if i == spike {
                r * (r / SOLITON_DELTA).ln().max(0.0) / kf
            } else {
                0.0
            };
            rho + tau
        })
        .collect();
    let z: f64 = mu.iter().sum();
    let mut acc = 0.0;
    for m in &mut mu {
        acc += *m / z;
        *m = acc;
    }
    if let Some(last) = mu.last_mut() {
        *last = 1.0;
    }
    mu
}

/// Source block indices combined in frame `seq`.
pub fn frame_blocks(seq: u32, k: usize, crc: u32, cdf: &[f64]) -> Vec<usize> {
    if (seq as usize) < k {
        return vec![seq as usize];
    }
    let mut rng = SplitMix64::new(u64::from(seq) ^ (u64::from(crc) << 32));
    let u = rng.next_f64();
    let d = cdf.iter().position(|&c| u < c).map_or(k, |p| p + 1).min(k);
    let mut idx: Vec<usize> = (0..k).collect();
    for i in 0..d {
        let j = i + rng.below((k - i) as u64) as usize;
        idx.swap(i, j);
    }
    idx.truncate(d);
    idx
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Header {
    len: u32,
    block: u16,
    crc: u32,
}

impl Header {
    fn k(&self) -> usize {
        (self.len as usize).div_ceil(usize::from(self.block)).max(1)
    }
}

/// Endless frame stream for one payload. Also supports random access via [`Encoder::frame`].
#[derive(Debug, Clone)]
pub struct Encoder {
    header: Header,
    blocks: Vec<Vec<u8>>,
    cdf: Vec<f64>,
    next: u32,
}

/// Starts encoding `payload` into frames of exactly `frame_size` bytes (header included,
/// so pick it from your QR version's byte capacity).
pub fn encode(payload: &[u8], frame_size: usize) -> Result<Encoder, QrError> {
    if frame_size <= HEADER_LEN || frame_size - HEADER_LEN > usize::from(u16::MAX) {
        return Err(QrError::BadFrameSize);
    }
    let len = u32::try_from(payload.len()).map_err(|_| QrError::TooLarge)?;
    let block = (frame_size - HEADER_LEN) as u16;
    let header = Header { len, block, crc: crc32(payload) };
    let bs = usize::from(block);
    let mut blocks: Vec<Vec<u8>> = payload.chunks(bs).map(|c| c.to_vec()).collect();
    if blocks.is_empty() {
        blocks.push(Vec::new());
    }
    for b in &mut blocks {
        b.resize(bs, 0);
    }
    let cdf = robust_soliton_cdf(blocks.len());
    Ok(Encoder { header, blocks, cdf, next: 0 })
}

impl Encoder {
    /// Number of source blocks `K`; a receiver needs a little more than `K` frames.
    pub fn source_blocks(&self) -> usize {
        self.blocks.len()
    }

    /// Frame number `seq`.
    pub fn frame(&self, seq: u32) -> Vec<u8> {
        let h = self.header;
        let mut f = Vec::with_capacity(HEADER_LEN + usize::from(h.block));
        f.push(VERSION);
        f.extend_from_slice(&h.len.to_be_bytes());
        f.extend_from_slice(&h.block.to_be_bytes());
        f.extend_from_slice(&h.crc.to_be_bytes());
        f.extend_from_slice(&seq.to_be_bytes());
        let mut data = vec![0u8; usize::from(h.block)];
        for i in frame_blocks(seq, self.blocks.len(), h.crc, &self.cdf) {
            xor_into(&mut data, &self.blocks[i]);
        }
        f.extend_from_slice(&data);
        f
    }
}

impl Iterator for Encoder {
    type Item = Vec<u8>;
    fn next(&mut self) -> Option<Vec<u8>> {
        let f = self.frame(self.next);
        self.next = self.next.wrapping_add(1);
        Some(f)
    }
}

fn xor_into(dst: &mut [u8], src: &[u8]) {
    dst.iter_mut().zip(src).for_each(|(d, s)| *d ^= s);
}

fn parse(frame: &[u8]) -> Result<(Header, u32, &[u8]), QrError> {
    if frame.len() < HEADER_LEN {
        return Err(QrError::Malformed);
    }
    if frame[0] != VERSION {
        return Err(QrError::Version(frame[0]));
    }
    let u32_at = |o: usize| u32::from_be_bytes(frame[o..o + 4].try_into().expect("4 bytes"));
    let header = Header { len: u32_at(1), block: u16::from_be_bytes([frame[5], frame[6]]), crc: u32_at(7) };
    let data = &frame[HEADER_LEN..];
    if header.block == 0 || data.len() != usize::from(header.block) {
        return Err(QrError::Malformed);
    }
    Ok((header, u32_at(11), data))
}

#[derive(Debug, Clone)]
struct Equation {
    blocks: BTreeSet<usize>,
    data: Vec<u8>,
}

/// Progress after feeding a frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Progress {
    /// Still collecting; `known` of `total` source blocks recovered.
    Partial { known: usize, total: usize },
    /// The payload is complete and its CRC matched.
    Complete,
}

/// Peeling decoder. Feed frames in any order; duplicates are ignored.
#[derive(Debug, Clone, Default)]
pub struct Decoder {
    header: Option<Header>,
    cdf: Vec<f64>,
    blocks: Vec<Option<Vec<u8>>>,
    known: usize,
    pending: Vec<Equation>,
    seen: BTreeSet<u32>,
    result: Option<Vec<u8>>,
}

impl Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds one frame. A frame from a different transfer is rejected with
    /// [`QrError::Mismatch`]; call [`Decoder::reset`] to switch transfers.
    pub fn push(&mut self, frame: &[u8]) -> Result<Progress, QrError> {
        let (h, seq, data) = parse(frame)?;
        match self.header {
            None => {
                let k = h.k();
                self.header = Some(h);
                self.cdf = robust_soliton_cdf(k);
                self.blocks = vec![None; k];
            }
            Some(cur) if cur != h => return Err(QrError::Mismatch),
            Some(_) => {}
        }
        if self.result.is_none() && self.seen.insert(seq) {
            let k = self.blocks.len();
            let eq = Equation { blocks: frame_blocks(seq, k, h.crc, &self.cdf).into_iter().collect(), data: data.to_vec() };
            self.add(eq);
            if self.known == k {
                self.finish(h);
            }
        }
        Ok(self.progress())
    }

    fn progress(&self) -> Progress {
        if self.result.is_some() {
            Progress::Complete
        } else {
            Progress::Partial { known: self.known, total: self.blocks.len() }
        }
    }

    fn add(&mut self, mut eq: Equation) {
        let known: Vec<usize> = eq.blocks.iter().copied().filter(|&i| self.blocks[i].is_some()).collect();
        for i in known {
            xor_into(&mut eq.data, self.blocks[i].as_ref().expect("known"));
            eq.blocks.remove(&i);
        }
        match eq.blocks.len() {
            0 => {}
            1 => {
                let i = *eq.blocks.first().expect("one");
                self.solve(i, eq.data);
            }
            _ => self.pending.push(eq),
        }
    }

    /// Records block `i` and peels every pending equation it unlocks.
    fn solve(&mut self, i: usize, data: Vec<u8>) {
        let mut work = vec![(i, data)];
        while let Some((i, data)) = work.pop() {
            if self.blocks[i].is_some() {
                continue;
            }
            for eq in &mut self.pending {
                if eq.blocks.remove(&i) {
                    xor_into(&mut eq.data, &data);
                }
            }
            self.blocks[i] = Some(data);
            self.known += 1;
            let mut rest = Vec::with_capacity(self.pending.len());
            for eq in self.pending.drain(..) {
                match eq.blocks.len() {
                    0 => {}
                    1 => work.push((*eq.blocks.first().expect("one"), eq.data)),
                    _ => rest.push(eq),
                }
            }
            self.pending = rest;
        }
    }

    fn finish(&mut self, h: Header) {
        let mut out: Vec<u8> = self.blocks.iter().flat_map(|b| b.as_ref().expect("complete").iter().copied()).collect();
        out.truncate(h.len as usize);
        if crc32(&out) == h.crc {
            self.result = Some(out);
            self.pending.clear();
        } else {
            // Corrupt frame got in; start over (camera decoders rarely pass bad frames).
            self.reset();
        }
    }

    /// The decoded payload, once complete.
    pub fn result(&self) -> Option<&[u8]> {
        self.result.as_deref()
    }

    pub fn is_complete(&self) -> bool {
        self.result.is_some()
    }

    /// Forgets everything (to receive a different transfer).
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(n: usize, seed: u64) -> Vec<u8> {
        let mut r = SplitMix64::new(seed);
        (0..n).map(|_| r.next_u64() as u8).collect()
    }

    /// Feeds frames, dropping each with probability `drop`, until complete. Returns the number
    /// of frames delivered to the decoder.
    fn transfer(data: &[u8], frame_size: usize, drop: f64, skip: usize, seed: u64, budget: usize) -> (Vec<u8>, usize) {
        let enc = encode(data, frame_size).unwrap();
        let mut rng = SplitMix64::new(seed);
        let mut dec = Decoder::new();
        let mut delivered = 0;
        for f in enc.skip(skip).take(budget) {
            if rng.next_f64() < drop {
                continue;
            }
            delivered += 1;
            if dec.push(&f).unwrap() == Progress::Complete {
                return (dec.result().unwrap().to_vec(), delivered);
            }
        }
        panic!("did not decode within {budget} frames ({delivered} delivered)");
    }

    #[test]
    fn soliton_cdf_is_a_distribution() {
        for k in [1, 2, 3, 10, 40, 100, 1000] {
            let cdf = robust_soliton_cdf(k);
            assert_eq!(cdf.len(), k);
            assert!(cdf.windows(2).all(|w| w[0] <= w[1]));
            assert_eq!(*cdf.last().unwrap(), 1.0);
        }
        // Degree 2 is the most likely for moderate K (ideal soliton's peak).
        let cdf = robust_soliton_cdf(100);
        assert!(cdf[1] - cdf[0] > cdf[0]);
    }

    #[test]
    fn frames_have_fixed_size_and_systematic_prefix() {
        let data = payload(1000, 1);
        let enc = encode(&data, 115).unwrap();
        assert_eq!(enc.source_blocks(), 10);
        for (i, f) in enc.clone().take(30).enumerate() {
            assert_eq!(f.len(), 115);
            if i < 10 {
                assert_eq!(&f[HEADER_LEN..], &data[i * 100..i * 100 + 100]);
            }
        }
        assert_eq!(encode(&data, HEADER_LEN).err(), Some(QrError::BadFrameSize));
    }

    #[test]
    fn decodes_with_30_percent_loss() {
        let data = payload(10_000, 2);
        for seed in 0..8 {
            let (out, delivered) = transfer(&data, 271, 0.3, 0, seed, 400);
            assert_eq!(out, data);
            assert!(delivered < 80, "seed {seed}: {delivered} frames for K=40");
        }
    }

    #[test]
    fn decodes_from_fountain_frames_only() {
        // A receiver that joined after the systematic prefix (and still loses 30%).
        let data = payload(5_000, 3);
        for seed in 0..4 {
            let (out, delivered) = transfer(&data, 115, 0.3, 50, seed, 2_000);
            assert_eq!(out, data);
            assert!(delivered < 150, "seed {seed}: {delivered} frames for K=50");
        }
    }

    #[test]
    fn edge_sizes() {
        for n in [0, 1, 99, 100, 101] {
            let data = payload(n, 4);
            assert_eq!(transfer(&data, 115, 0.0, 0, 0, 10).0, data);
        }
    }

    #[test]
    fn rejects_bad_frames() {
        let mut dec = Decoder::new();
        assert_eq!(dec.push(&[1, 2, 3]), Err(QrError::Malformed));
        let a = encode(b"hello world", 20).unwrap().frame(0);
        let mut v2 = a.clone();
        v2[0] = 2;
        assert_eq!(dec.push(&v2), Err(QrError::Version(2)));
        assert!(dec.push(&a).is_ok());
        let other = encode(b"other transfer", 20).unwrap().frame(0);
        assert_eq!(dec.push(&other), Err(QrError::Mismatch));
        assert!(dec.push(&a[..a.len() - 1]).is_err());
        // Duplicates don't count twice.
        assert_eq!(dec.push(&a), Ok(Progress::Partial { known: 1, total: 3 }));
        dec.reset();
        assert!(dec.push(&other).is_ok());
    }
}
