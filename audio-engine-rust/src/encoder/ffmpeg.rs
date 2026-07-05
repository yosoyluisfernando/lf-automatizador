use super::config::{percent_encode_component, EncoderCodec, EncoderServerConfig, ServerType};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum FfmpegMode {
    Icecast,
    LocalNull,
    ShoutcastPipe,
    UltravoxPipe,
}

impl FfmpegMode {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Icecast => "icecast",
            Self::LocalNull => "local-null",
            Self::ShoutcastPipe => "shoutcast-pipe",
            Self::UltravoxPipe => "ultravox-pipe",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FfmpegPlan {
    pub(crate) mode: FfmpegMode,
    pub(crate) args: Vec<String>,
}

impl FfmpegPlan {
    pub(crate) fn from_config(config: &EncoderServerConfig) -> Self {
        Self::from_config_with_local_null(config, false)
    }

    pub(crate) fn from_config_with_local_null(
        config: &EncoderServerConfig,
        local_null: bool,
    ) -> Self {
        let mode = resolve_mode(config);
        let mut args = vec!["-hide_banner".to_string(), "-nostdin".to_string()];
        args.extend(build_input_args(config));
        if local_null {
            args.extend(["-f", "null", "-"].map(String::from));
            return Self {
                mode: FfmpegMode::LocalNull,
                args,
            };
        }
        match mode {
            FfmpegMode::Icecast => {
                args.extend(build_icecast_output_args(config));
                args.push(build_stream_url(config));
            }
            FfmpegMode::ShoutcastPipe | FfmpegMode::UltravoxPipe => {
                args.extend(build_pipe_output_args(config));
            }
            FfmpegMode::LocalNull => {}
        }
        Self { mode, args }
    }
}

fn resolve_mode(config: &EncoderServerConfig) -> FfmpegMode {
    match config.server_type {
        ServerType::Icecast => FfmpegMode::Icecast,
        ServerType::Shoutcast => FfmpegMode::ShoutcastPipe,
        ServerType::Shoutcast2 if config.legacy => FfmpegMode::ShoutcastPipe,
        ServerType::Shoutcast2 => FfmpegMode::UltravoxPipe,
    }
}

fn build_input_args(config: &EncoderServerConfig) -> Vec<String> {
    if config.capture_format == "pcm_s16le" {
        vec![
            "-f".to_string(),
            "s16le".to_string(),
            "-ar".to_string(),
            config.sample_rate.to_string(),
            "-ac".to_string(),
            "2".to_string(),
            "-i".to_string(),
            "pipe:0".to_string(),
        ]
    } else {
        vec![
            "-f".to_string(),
            "webm".to_string(),
            "-c:a".to_string(),
            "opus".to_string(),
            "-i".to_string(),
            "pipe:0".to_string(),
        ]
    }
}

fn common_codec_args(config: &EncoderServerConfig) -> Vec<String> {
    let mut args = vec![
        "-vn".to_string(),
        "-ac".to_string(),
        "2".to_string(),
        "-ar".to_string(),
        "44100".to_string(),
    ];
    if config.capture_format != "pcm_s16le" {
        args.extend([
            "-af".to_string(),
            "aresample=async=1:first_pts=0".to_string(),
        ]);
    }
    args
}

fn build_icecast_output_args(config: &EncoderServerConfig) -> Vec<String> {
    let mut args = common_codec_args(config);
    append_codec_args(&mut args, config, false);
    args
}

fn build_pipe_output_args(config: &EncoderServerConfig) -> Vec<String> {
    let mut args = common_codec_args(config);
    append_codec_args(&mut args, config, true);
    args.push("pipe:1".to_string());
    args
}

fn append_codec_args(args: &mut Vec<String>, config: &EncoderServerConfig, pipe_output: bool) {
    let br = config.bitrate_kbps.to_string();
    match config.codec {
        EncoderCodec::Aac => {
            args.extend(["-c:a", "aac", "-b:a"].map(String::from));
            args.push(format!("{}k", br));
            args.extend(["-f", "adts"].map(String::from));
            if !pipe_output {
                args.extend(["-content_type", "audio/aac"].map(String::from));
            }
        }
        EncoderCodec::AacHe => {
            args.extend(["-c:a", "libfdk_aac", "-profile:a", "aac_he", "-b:a"].map(String::from));
            args.push(format!("{}k", br));
            args.extend(["-f", "adts"].map(String::from));
            if !pipe_output {
                args.extend(["-content_type", "audio/aac"].map(String::from));
            }
        }
        EncoderCodec::Mp3 => {
            args.extend(["-c:a", "libmp3lame", "-b:a"].map(String::from));
            args.push(format!("{}k", br));
            args.extend(["-minrate"].map(String::from));
            args.push(format!("{}k", br));
            args.extend(["-maxrate"].map(String::from));
            args.push(format!("{}k", br));
            args.extend(["-bufsize"].map(String::from));
            args.push(format!("{}k", config.bitrate_kbps.saturating_mul(2)));
            if pipe_output {
                args.extend(["-id3v2_version", "0", "-write_id3v1", "0"].map(String::from));
            }
            args.extend(["-f", "mp3"].map(String::from));
            if !pipe_output {
                args.extend(["-content_type", "audio/mpeg"].map(String::from));
            }
        }
    }
}

fn build_stream_url(config: &EncoderServerConfig) -> String {
    let password = percent_encode_component(&config.password);
    match config.server_type {
        ServerType::Shoutcast => {
            format!(
                "icecast://source:{}@{}:{}/1",
                password, config.host, config.port
            )
        }
        ServerType::Shoutcast2 => {
            let sid = config
                .mount
                .chars()
                .filter(|c| c.is_ascii_digit())
                .collect::<String>();
            let sid = if sid.is_empty() { "1" } else { sid.as_str() };
            format!(
                "icecast://source:{}@{}:{}/{}",
                password, config.host, config.port, sid
            )
        }
        ServerType::Icecast => {
            let user = percent_encode_component(&config.user);
            let mount = encode_mount(&config.mount);
            format!(
                "icecast://{}:{}@{}:{}{}",
                user, password, config.host, config.port, mount
            )
        }
    }
}

fn encode_mount(value: &str) -> String {
    let mount = if value.trim().is_empty() {
        "/stream"
    } else {
        value
    };
    mount
        .split('/')
        .map(percent_encode_component)
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::IncomingCommand;

    fn config(json: &str) -> EncoderServerConfig {
        let cmd = IncomingCommand::parse(json).unwrap();
        EncoderServerConfig::from_command(&cmd).unwrap()
    }

    #[test]
    fn icecast_mp3_plan_writes_to_url() {
        let cfg = config(
            r#"{"serverType":"icecast","ip":"host","port":"8000","password":"pa ss","mount":"main live","codec":"mp3","bitrate":"128"}"#,
        );
        let plan = FfmpegPlan::from_config(&cfg);
        assert_eq!(plan.mode, FfmpegMode::Icecast);
        assert!(plan.args.contains(&"-content_type".to_string()));
        assert!(plan.args.contains(&"audio/mpeg".to_string()));
        assert!(plan
            .args
            .contains(&"icecast://source:pa%20ss@host:8000/main%20live".to_string()));
    }

    #[test]
    fn shoutcast_classic_uses_pipe_without_id3() {
        let cfg = config(
            r#"{"serverType":"shoutcast","ip":"host","port":"8000","password":"secret","codec":"mp3","bitrate":"96"}"#,
        );
        let plan = FfmpegPlan::from_config(&cfg);
        assert_eq!(plan.mode, FfmpegMode::ShoutcastPipe);
        assert!(plan.args.contains(&"-id3v2_version".to_string()));
        assert!(plan.args.contains(&"pipe:1".to_string()));
    }

    #[test]
    fn shoutcast2_native_uses_ultravox_pipe() {
        let cfg = config(
            r#"{"serverType":"shoutcast2","ip":"host","port":"8000","password":"secret","mount":"2","codec":"aac","bitrate":"64"}"#,
        );
        let plan = FfmpegPlan::from_config(&cfg);
        assert_eq!(plan.mode, FfmpegMode::UltravoxPipe);
        assert!(plan.args.contains(&"adts".to_string()));
        assert!(plan.args.contains(&"pipe:1".to_string()));
    }

    #[test]
    fn non_pcm_input_adds_resample_filter() {
        let cfg = config(
            r#"{"serverType":"icecast","ip":"host","port":"8000","password":"secret","mount":"live","codec":"aac","bitrate":"128","captureFormat":"webm-opus"}"#,
        );
        let plan = FfmpegPlan::from_config(&cfg);
        assert!(plan.args.contains(&"webm".to_string()));
        assert!(plan
            .args
            .contains(&"aresample=async=1:first_pts=0".to_string()));
    }

    #[test]
    fn local_null_plan_never_contains_network_url() {
        let cfg = config(
            r#"{"serverType":"icecast","ip":"host","port":"8000","password":"secret","mount":"live","codec":"mp3","bitrate":"128"}"#,
        );
        let plan = FfmpegPlan::from_config_with_local_null(&cfg, true);
        assert_eq!(plan.mode, FfmpegMode::LocalNull);
        assert!(plan
            .args
            .ends_with(&["-f".to_string(), "null".to_string(), "-".to_string()]));
        assert!(!plan.args.iter().any(|arg| arg.starts_with("icecast://")));
    }
}
