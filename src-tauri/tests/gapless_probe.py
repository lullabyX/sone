#!/usr/bin/env python3
"""Gapless capability probe. Requires python3-gi + GStreamer. Verifies GStreamer>=1.24,
uridecodebin3 with about-to-finish, and dashdemux2 (for data: DASH manifests)."""
import sys, gi
gi.require_version("Gst", "1.0")
from gi.repository import Gst, GObject
Gst.init(None)

def fail(m): print(f"FAIL: {m}"); sys.exit(1)

ver = Gst.version()
if (ver[0], ver[1]) < (1, 24):
    fail(f"GStreamer {ver} < 1.24 (data: DASH manifests unsupported)")
udb = Gst.ElementFactory.make("uridecodebin3", None)
if udb is None: fail("uridecodebin3 not available")
if GObject.signal_lookup("about-to-finish", udb.__gtype__) == 0: fail("no about-to-finish signal")
if udb.find_property("instant-uri") is None:
    print("WARN: no instant-uri property (not required by SONE; about-to-finish path unaffected)")
if Gst.ElementFactory.make("dashdemux2", None) is None: fail("dashdemux2 not available")
print(f"OK: GStreamer {ver}, uridecodebin3 + dashdemux2 present, gapless-capable")
sys.exit(0)
