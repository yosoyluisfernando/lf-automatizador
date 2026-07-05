use std::fs::File;
use std::io::{self, Seek, SeekFrom, Write};
use std::path::Path;

pub(crate) struct WavWriter {
    file: File,
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
    data_bytes_written: u64,
}

impl WavWriter {
    pub(crate) fn create(
        path: &Path,
        sample_rate: u32,
        channels: u16,
        bits_per_sample: u16,
    ) -> io::Result<Self> {
        let mut file = File::create(path)?;
        let header = build_wav_header(sample_rate, channels, bits_per_sample, 0);
        file.write_all(&header)?;
        Ok(Self {
            file,
            sample_rate,
            channels,
            bits_per_sample,
            data_bytes_written: 0,
        })
    }

    pub(crate) fn write_pcm_bytes(&mut self, data: &[u8]) -> io::Result<()> {
        self.file.write_all(data)?;
        self.data_bytes_written += data.len() as u64;
        Ok(())
    }

    pub(crate) fn bytes_written(&self) -> u64 {
        self.data_bytes_written
    }

    pub(crate) fn finalize(mut self) -> io::Result<u64> {
        self.update_header()?;
        self.file.flush()?;
        Ok(self.data_bytes_written)
    }

    fn update_header(&mut self) -> io::Result<()> {
        let header = build_wav_header(
            self.sample_rate,
            self.channels,
            self.bits_per_sample,
            self.data_bytes_written,
        );
        self.file.seek(SeekFrom::Start(0))?;
        self.file.write_all(&header)?;
        self.file.seek(SeekFrom::End(0))?;
        Ok(())
    }
}

impl Drop for WavWriter {
    fn drop(&mut self) {
        let _ = self.update_header();
        let _ = self.file.flush();
    }
}

fn build_wav_header(
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
    data_size: u64,
) -> Vec<u8> {
    let block_align = channels * (bits_per_sample / 8);
    let byte_rate = sample_rate * u32::from(block_align);
    let data_size_u32 = if data_size > u32::MAX as u64 {
        u32::MAX
    } else {
        data_size as u32
    };
    let riff_size = 36 + data_size_u32;

    let mut h = Vec::with_capacity(44);
    h.extend_from_slice(b"RIFF");
    h.extend_from_slice(&riff_size.to_le_bytes());
    h.extend_from_slice(b"WAVE");
    h.extend_from_slice(b"fmt ");
    h.extend_from_slice(&16u32.to_le_bytes());
    h.extend_from_slice(&1u16.to_le_bytes()); // PCM
    h.extend_from_slice(&channels.to_le_bytes());
    h.extend_from_slice(&sample_rate.to_le_bytes());
    h.extend_from_slice(&byte_rate.to_le_bytes());
    h.extend_from_slice(&block_align.to_le_bytes());
    h.extend_from_slice(&bits_per_sample.to_le_bytes());
    h.extend_from_slice(b"data");
    h.extend_from_slice(&data_size_u32.to_le_bytes());
    h
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn wav_header_size() {
        let h = build_wav_header(44100, 2, 16, 0);
        assert_eq!(h.len(), 44);
        assert_eq!(&h[0..4], b"RIFF");
        assert_eq!(&h[8..12], b"WAVE");
        assert_eq!(&h[12..16], b"fmt ");
        assert_eq!(&h[36..40], b"data");
    }

    #[test]
    fn wav_write_and_finalize() {
        let dir = std::env::temp_dir();
        let path = dir.join("test_recorder_wav.wav");
        {
            let mut w = WavWriter::create(&path, 44100, 2, 16).unwrap();
            let pcm = vec![0u8; 8820]; // some PCM
            w.write_pcm_bytes(&pcm).unwrap();
            assert_eq!(w.bytes_written(), 8820);
            w.finalize().unwrap();
        }
        let mut file = File::open(&path).unwrap();
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).unwrap();
        assert_eq!(buf.len(), 44 + 8820);
        assert_eq!(&buf[0..4], b"RIFF");
        let data_size = u32::from_le_bytes([buf[40], buf[41], buf[42], buf[43]]);
        assert_eq!(data_size, 8820);
        let _ = std::fs::remove_file(&path);
    }
}
