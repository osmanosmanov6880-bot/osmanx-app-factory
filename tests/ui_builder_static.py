"""Legacy UI entrypoint: use the maintained R1.3 Chromium editor test.
The old static mock was tied to the pre-OBSIDIAN card selectors and is no longer
a meaningful regression check. This delegates to the current real editor QA.
"""
from pathlib import Path
import runpy
runpy.run_path(str(Path(__file__).with_name('ui_r13_grid.py')), run_name='__main__')
