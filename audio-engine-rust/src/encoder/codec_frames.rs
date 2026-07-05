const MPEG1_LAYER3_BITRATES: [usize; 16] = [
    0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
const MPEG2_LAYER3_BITRATES: [usize; 16] = [
    0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodecFrameKind {
    Mp3,
    Aac,
}

#[derive(Clone, Debug)]
pub(crate) struct CodecFrameAccumulator {
    kind: CodecFrameKind,
    buffer: Vec<u8>,
}

impl CodecFrameAccumulator {
    pub(crate) fn new(kind: CodecFrameKind) -> Self {
        Self {
            kind,
            buffer: Vec::new(),
        }
    }

    pub(crate) fn push(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        if !chunk.is_empty() {
            self.buffer.extend_from_slice(chunk);
        }
        let mut frames = Vec::new();
        let mut offset = 0usize;
        while offset < self.buffer.len() {
            let length = match self.kind {
                CodecFrameKind::Mp3 => read_mp3_frame_length(&self.buffer, offset),
                CodecFrameKind::Aac => read_adts_frame_length(&self.buffer, offset),
            };
            if length == 0 {
                break;
            }
            if length < 0 {
                offset += 1;
                continue;
            }
            let length = length as usize;
            if offset + length > self.buffer.len() {
                break;
            }
            frames.push(self.buffer[offset..offset + length].to_vec());
            offset += length;
        }
        if offset > 0 {
            self.buffer.drain(..offset);
        }
        frames
    }
}

fn read_adts_frame_length(buffer: &[u8], offset: usize) -> isize {
    if offset + 7 > buffer.len() {
        return 0;
    }
    if buffer[offset] != 0xff || (buffer[offset + 1] & 0xf6) != 0xf0 {
        return -1;
    }
    (((buffer[offset + 3] & 0x03) as usize) << 11
        | ((buffer[offset + 4] as usize) << 3)
        | (((buffer[offset + 5] & 0xe0) as usize) >> 5)) as isize
}

fn read_mp3_frame_length(buffer: &[u8], offset: usize) -> isize {
    if offset + 4 > buffer.len() {
        return 0;
    }
    let one = buffer[offset + 1];
    let two = buffer[offset + 2];
    if buffer[offset] != 0xff || (one & 0xe0) != 0xe0 {
        return -1;
    }
    let version = (one >> 3) & 0x03;
    let layer = (one >> 1) & 0x03;
    let bitrate_index = ((two >> 4) & 0x0f) as usize;
    let sample_rate_index = ((two >> 2) & 0x03) as usize;
    if version == 1 || layer != 1 || sample_rate_index == 3 {
        return -1;
    }
    let bitrate = if version == 3 {
        MPEG1_LAYER3_BITRATES[bitrate_index]
    } else {
        MPEG2_LAYER3_BITRATES[bitrate_index]
    };
    let sample_rate = match version {
        3 => [44100usize, 48000, 32000][sample_rate_index],
        2 => [22050usize, 24000, 16000][sample_rate_index],
        0 => [11025usize, 12000, 8000][sample_rate_index],
        _ => 0,
    };
    if bitrate == 0 || sample_rate == 0 {
        return -1;
    }
    let padding = ((two >> 1) & 0x01) as usize;
    let coefficient = if version == 3 { 144 } else { 72 };
    ((coefficient * bitrate * 1000 / sample_rate) + padding) as isize
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accumulates_mp3_frame_after_noise() {
        let frame = vec![0xff, 0xfb, 0x90, 0x64];
        let mut full = frame.clone();
        full.resize(417, 0);
        let mut acc = CodecFrameAccumulator::new(CodecFrameKind::Mp3);
        let frames = acc.push(&[1, 2, 3]);
        assert!(frames.is_empty());
        let mut chunk = vec![0, 1];
        chunk.extend_from_slice(&full);
        let frames = acc.push(&chunk);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].len(), 417);
    }

    #[test]
    fn accumulates_adts_frame() {
        let mut frame = vec![0xff, 0xf1, 0x50, 0x80, 0x01, 0x7f, 0xfc];
        frame.resize(11, 0);
        let mut acc = CodecFrameAccumulator::new(CodecFrameKind::Aac);
        let frames = acc.push(&frame);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].len(), 11);
    }
}
