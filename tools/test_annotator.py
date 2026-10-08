"""Compatibility entry point; failures propagate through unittest's exit status."""
import runpy
from pathlib import Path

if __name__ == '__main__':
    runpy.run_path(str(Path(__file__).resolve().parents[1] / 'test/test_pdf_backend.py'), run_name='__main__')
