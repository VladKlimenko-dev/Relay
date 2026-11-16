"""Download one GGUF file from Hugging Face with resume support. Usage: download_model.py REPO FILE DEST_DIR [REVISION]"""
import sys

from huggingface_hub import hf_hub_download

if len(sys.argv) not in (4, 5):
    sys.exit("usage: download_model.py REPO FILE DEST_DIR [REVISION]")
repo, filename, dest = sys.argv[1:4]
revision = sys.argv[4] if len(sys.argv) == 5 else None
print(hf_hub_download(repo_id=repo, filename=filename, local_dir=dest, revision=revision))
