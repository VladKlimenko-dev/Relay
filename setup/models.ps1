# Model catalog shared by setup.ps1 and start-relay.ps1. Sizes are exact file sizes from Hugging Face.
$RelayModels = [ordered]@{
  "38-27b" = @{
    Label     = "Qwen3.8-27B UD-Q4_K_M (default: 128K context fully in 24 GB VRAM)"
    Repo      = "unsloth/Qwen3.8-27B-GGUF"
    File      = "Qwen3.8-27B-UD-Q4_K_M.gguf"
    Bytes     = 16564259744
    OllamaTag = "qwen3.8:27b"
    OllamaGB  = 18
    ArcCtx    = 131072
  }
  "38-27b-q5" = @{
    Label     = "Qwen3.8-27B UD-Q5_K_M (slightly higher precision, 48K context in VRAM)"
    Repo      = "unsloth/Qwen3.8-27B-GGUF"
    File      = "Qwen3.8-27B-UD-Q5_K_M.gguf"
    Bytes     = 19870878624
    OllamaTag = "qwen3.8:27b"
    OllamaGB  = 18
    ArcCtx    = 49152
  }
  "36-27b" = @{
    Label     = "Qwen3.6-27B Q5_K_M (previous generation, for comparison)"
    Repo      = "unsloth/Qwen3.6-27B-GGUF"
    File      = "Qwen3.6-27B-Q5_K_M.gguf"
    Bytes     = 19509790944
    OllamaTag = "qwen3.6:27b"
    OllamaGB  = 19
    ArcCtx    = 49152
  }
  "36-35b" = @{
    Label     = "Qwen3.6-35B-A3B UD-Q4_K_M (MoE, faster, lower coding scores)"
    Repo      = "unsloth/Qwen3.6-35B-A3B-GGUF"
    File      = "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"
    Bytes     = 22134528992
    OllamaTag = "qwen3.6:35b"
    OllamaGB  = 24
    ArcCtx    = 32768
  }
}

# Small CPU-only model for display-only summaries of the main model's thinking (Russian/English, Apache-2.0).
# Pinned to a Hugging Face revision; size and SHA-256 are the LFS metadata of that revision.
$RelaySummarizer = @{
  Label    = "Qwen2.5-1.5B-Instruct Q4_K_M (CPU thinking summaries)"
  Repo     = "Qwen/Qwen2.5-1.5B-Instruct-GGUF"
  Revision = "91cad51170dc346986eccefdc2dd33a9da36ead9"
  File     = "qwen2.5-1.5b-instruct-q4_k_m.gguf"
  Bytes    = 1117320736
  Sha256   = "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e"
  Port     = 8091
}
