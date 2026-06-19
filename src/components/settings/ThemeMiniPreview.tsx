import type { CSSProperties } from "react";
import { deriveTheme, themeToCssVars } from "../../lib/theme";

// App-in-miniature preview. The root carries the FULL palette re-derived from
// the given accent/bg as scoped `--th-*` CSS variables, so the mini layout
// reflects any preset or custom color (including light themes). The markup
// below consumes those scoped vars directly (NOT the app's global vars).
const styles = `
.tmp-app { display:flex; flex-direction:column; height:214px; background:var(--th-bg-base); border:1px solid var(--th-border-subtle); border-radius:13px; overflow:hidden; }
.tmp-app .tb { height:13px; flex-shrink:0; background:var(--th-bg-sidebar); border-bottom:1px solid var(--th-border-subtle); display:flex; align-items:center; padding:0 8px; gap:4px; }
.tmp-app .tb i { width:5px; height:5px; border-radius:50%; background:color-mix(in srgb, var(--th-text-primary) 22%, transparent); }
.tmp-app .row { flex:1; display:flex; min-height:0; }
.tmp-app .side { width:74px; flex-shrink:0; background:var(--th-bg-sidebar); padding:10px 9px; display:flex; flex-direction:column; gap:7px; overflow:hidden; }
.tmp-app .logo { width:20px; height:20px; border-radius:6px; background:var(--th-accent); margin-bottom:2px; }
.tmp-app .nav { height:6px; border-radius:3px; background:color-mix(in srgb, var(--th-text-primary) 13%, transparent); width:90%; }
.tmp-app .nav.active { background:var(--th-accent); width:80%; }
.tmp-app .sep { height:1px; background:var(--th-border-subtle); margin:3px 0 4px; }
.tmp-app .pl { height:5px; border-radius:3px; background:color-mix(in srgb, var(--th-text-primary) 9%, transparent); width:85%; }
.tmp-app .main { flex:1; min-width:0; display:flex; flex-direction:column; }
.tmp-app .head { height:32px; flex-shrink:0; display:flex; align-items:center; gap:7px; padding:0 12px; }
.tmp-app .circ { width:13px; height:13px; border-radius:50%; background:color-mix(in srgb, var(--th-text-primary) 9%, transparent); }
.tmp-app .search { width:116px; height:15px; border-radius:999px; background:var(--th-bg-surface); border:1px solid var(--th-border-subtle); margin-left:5px; }
.tmp-app .avatar { width:15px; height:15px; border-radius:50%; background:var(--th-accent); margin-left:auto; }
.tmp-app .content { flex:1; min-height:0; padding:3px 12px 12px; display:flex; flex-direction:column; gap:9px; }
.tmp-app .h1 { width:78px; height:9px; border-radius:5px; background:color-mix(in srgb, var(--th-text-primary) 72%, transparent); }
.tmp-app .cards { display:flex; gap:9px; }
.tmp-app .cardx { flex:1; border-radius:8px; background:var(--th-bg-surface); border:1px solid var(--th-border-subtle); padding:7px; display:flex; flex-direction:column; gap:5px; }
.tmp-app .cardx .cv { height:40px; border-radius:5px; background:linear-gradient(140deg, var(--th-accent), color-mix(in srgb, var(--th-accent) 22%, #000)); }
.tmp-app .cardx .ln { height:5px; width:72%; border-radius:3px; background:color-mix(in srgb, var(--th-text-primary) 22%, transparent); }
.tmp-app .player { height:46px; flex-shrink:0; position:relative; background:var(--th-bg-elevated); border-top:1px solid var(--th-border-subtle); display:flex; align-items:center; gap:10px; padding:0 13px; }
.tmp-app .scrub { position:absolute; left:0; right:0; top:0; height:2px; background:color-mix(in srgb, var(--th-text-primary) 12%, transparent); }
.tmp-app .scrub > i { position:absolute; left:0; top:0; bottom:0; width:35%; background:var(--th-accent); }
.tmp-app .pcover { width:30px; height:30px; border-radius:5px; flex-shrink:0; background:linear-gradient(140deg, var(--th-accent), color-mix(in srgb, var(--th-accent) 22%, #000)); }
.tmp-app .pmeta { width:78px; display:flex; flex-direction:column; gap:4px; }
.tmp-app .pt { height:6px; width:72%; border-radius:3px; background:color-mix(in srgb, var(--th-text-primary) 60%, transparent); }
.tmp-app .ps { height:5px; width:46%; border-radius:3px; background:color-mix(in srgb, var(--th-text-primary) 25%, transparent); }
.tmp-app .pctrl { margin:0 auto; display:flex; align-items:center; gap:9px; }
.tmp-app .pctrl .d { width:8px; height:8px; border-radius:50%; background:color-mix(in srgb, var(--th-text-primary) 30%, transparent); }
.tmp-app .pplay { width:20px; height:20px; border-radius:50%; background:var(--th-accent); }
.tmp-app .pvol { width:40px; height:4px; border-radius:2px; background:color-mix(in srgb, var(--th-text-primary) 14%, transparent); margin-left:auto; }
`;

export default function ThemeMiniPreview({
  accent,
  bg,
}: {
  accent: string;
  bg: string;
}) {
  const vars = themeToCssVars(deriveTheme(accent, bg)) as CSSProperties;

  return (
    <div className="tmp-app" style={vars}>
      <style>{styles}</style>
      <div className="tb">
        <i />
        <i />
        <i />
      </div>
      <div className="row">
        <div className="side">
          <div className="logo" />
          <div className="nav active" />
          <div className="nav" />
          <div className="nav" />
          <div className="sep" />
          <div className="pl" />
          <div className="pl" style={{ width: "78%" }} />
          <div className="pl" style={{ width: "82%" }} />
          <div className="pl" style={{ width: "68%" }} />
        </div>
        <div className="main">
          <div className="head">
            <div className="circ" />
            <div className="circ" />
            <div className="search" />
            <div className="avatar" />
          </div>
          <div className="content">
            <div className="h1" />
            <div className="cards">
              <div className="cardx">
                <div className="cv" />
                <div className="ln" />
              </div>
              <div className="cardx">
                <div className="cv" />
                <div className="ln" />
              </div>
              <div className="cardx">
                <div className="cv" />
                <div className="ln" />
              </div>
              <div className="cardx">
                <div className="cv" />
                <div className="ln" />
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="player">
        <div className="scrub">
          <i />
        </div>
        <div className="pcover" />
        <div className="pmeta">
          <div className="pt" />
          <div className="ps" />
        </div>
        <div className="pctrl">
          <span className="d" />
          <span className="pplay" />
          <span className="d" />
        </div>
        <div className="pvol" />
      </div>
    </div>
  );
}
