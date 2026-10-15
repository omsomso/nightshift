# User guide source

`make_guide.py` builds `docs/Nightshift-Guide.pdf` with ReportLab. It needs Python 3 with
`reportlab` (for example in a throwaway virtual environment):

```sh
python3 -m venv /tmp/guide-env && /tmp/guide-env/bin/pip install reportlab
/tmp/guide-env/bin/python docs/guide/make_guide.py docs/Nightshift-Guide.pdf
```

It uses the macOS Menlo font for code. Update the guide when commands or the app change.
