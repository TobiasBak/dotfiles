#!/usr/bin/env python3
import json
import subprocess

out = json.loads(subprocess.check_output(['niri', 'msg', '--json', 'focused-output']))
out_w = out['logical']['width']

# Fixed position: top-right of output, below the bar
popup_x = out_w - 130  # 130px from right edge
popup_y = 54  # Below the top bar

print(f"{popup_x}\t{popup_y}\t{out['name']}")
