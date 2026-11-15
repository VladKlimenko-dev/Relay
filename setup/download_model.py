"""Download one GGUF file from Hugging Face with resume support. Usage: download_model.py REPO FILE DEST_DIR"""
import sys

from huggingface_hub import hf_hub_download

if len(sys.argv) != 4:
    sys.exit("usage: download_model.py REPO FILE DEST_DIR")
repo, filename, dest = sys.argv[1:4]
print(hf_hub_download(repo_id=repo, filename=filename, local_dir=dest))
