import React, { useState, useMemo, useRef, useEffect } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceDot, ResponsiveContainer,
} from "recharts";
import {
  MapPin, Home, ThermometerSun, ChevronRight, ChevronLeft, Settings2,
  Info, ArrowRight, CircleCheck, ShieldCheck, Volume2, Clock, Lock,
  Sparkles, BookOpen, ArrowLeft, Plus, Minus, X,
} from "lucide-react";

/* ============================================================
   CONFIGURATION LAYER (mirrors the Python engine/defaults.py)

   Everything a business would ever want to change without touching
   calculation code lives in this one object. The Admin panel edits a
   copy of this at runtime (client-side demo only -- see the Admin
   screen for the production caveat). Nothing below this block should
   ever be hard-coded again inside a formula.
   ============================================================ */

const DEFAULT_CONFIG = {
  climates: {
    coastal: {
      id: "coastal", name: "Coastal", examples: "Beirut, Tripoli, Batroun, Jounieh",
      summerDesign: 33, summerAvg: 28, winterDesign: 9, winterAvg: 13,
      coolSet: 24, heatSet: 21, coolHours: 1900, heatHours: 900,
      solarPeak: 300, solarAvg: 130,
    },
    middle: {
      id: "middle", name: "Middle Elevation", examples: "Mid-altitude towns and suburbs",
      summerDesign: 30, summerAvg: 24, winterDesign: 3, winterAvg: 8,
      coolSet: 24, heatSet: 21, coolHours: 1300, heatHours: 1600,
      solarPeak: 320, solarAvg: 140,
    },
    high: {
      id: "high", name: "High Elevation", examples: "Faraya, Bcharre, Cedars and higher",
      summerDesign: 26, summerAvg: 19, winterDesign: -4, winterAvg: 3,
      coolSet: 24, heatSet: 21, coolHours: 600, heatHours: 2600,
      solarPeak: 340, solarAvg: 150,
    },
  },
  buildings: {
    old: { id: "old", name: "Older / Less insulated", wallU: 3.02, roofU: 2.45, desc: "Older construction, limited insulation" },
    average: { id: "average", name: "Average", wallU: 1.8, roofU: 1.4, desc: "Typical residential construction" },
    modern: { id: "modern", name: "Modern / Well insulated", wallU: 0.6, roofU: 0.45, desc: "Newer construction, good envelope performance" },
  },
  usage: {
    heavy: { id: "heavy", name: "Heavy use", cool: 0.75, heat: 0.75, hours: "Roughly 8-16 h/day when the season calls for it" },
    normal: { id: "normal", name: "Normal use", cool: 0.45, heat: 0.45, hours: "Roughly 4-8 h/day, mainly evenings and peak heat" },
    light: { id: "light", name: "Light use", cool: 0.2, heat: 0.2, hours: "Roughly 1-4 h/day, only when needed" },
  },
  aluminium: { id: "aluminium", name: "Standard Aluminium", material: "Non-thermally-broken aluminium", u: 5.8, shgc: 0.7, price: 180 },
  glazingBasePrice: { single: 200, double: 260, triple: 340 },
  lowEAdder: 25,
  argonAdder: 18,
  glazingPhysics: {
    // key: layers_lowE_argon -> [u, shgc]
    "single--": [5.5, 0.82],
    "double--": [2.7, 0.72],
    "double-argon": [2.3, 0.71],
    "double-lowe-": [1.9, 0.45],
    "double-lowe-argon": [1.6, 0.42],
    "triple--": [1.8, 0.68],
    "triple-argon": [1.5, 0.67],
    "triple-lowe-": [1.2, 0.42],
    "triple-lowe-argon": [0.8, 0.38],
  },
  hvac: { coolingCOP: 3.0, heatingCOP: 2.5 },
  econ: { price: 0.27, escalation: 0.03, years: 15 },
  bounds: {
    areaMin: 5, areaMax: 1000,
    priceMin: 0.05, priceMax: 2.0,
    wallUMin: 0.2, wallUMax: 4.0,
    roofUMin: 0.2, roofUMax: 3.5,
  },
  assumptions: { wallAreaPerWindowM2: 3.0, roofAreaPerWindowM2: 1.0, maxSwingC: 5.0 },
};

const BTU_PER_WATT = 3.412142;
const MODEL_VERSION = "1.1";

/* ============================================================
   CALCULATION ENGINE (JS port of the Python engine/ package)
   Parameterized entirely by `config` -- no hard-coded commercial or
   scientific values live inside these functions (spec principle 3).
   ============================================================ */

function glazingKey(layers, lowE, argon) {
  return `${layers}-${lowE ? "lowe" : ""}-${argon ? "argon" : ""}`;
}

function getGlazing(config, layers, lowE, argon) {
  const key = glazingKey(layers, lowE, argon);
  const [u, shgc] = config.glazingPhysics[key] || config.glazingPhysics[`${layers}--`];
  let price = config.glazingBasePrice[layers];
  if (lowE) price += config.lowEAdder;
  if (argon) price += config.argonAdder;
  return { id: key, layers, lowE, argon, u, shgc, price };
}

function peakLoad(u, shgc, areaM2, climate) {
  const coolDeltaT = Math.max(climate.summerDesign - climate.coolSet, 0);
  const conduction = u * areaM2 * coolDeltaT;
  const solar = shgc * areaM2 * climate.solarPeak;
  const coolingW = conduction + solar;
  const heatDeltaT = Math.max(climate.heatSet - climate.winterDesign, 0);
  const heatingW = u * areaM2 * heatDeltaT;
  return { coolingW, coolingBtuH: coolingW * BTU_PER_WATT, heatingW, heatingBtuH: heatingW * BTU_PER_WATT };
}

function avgLoad(u, shgc, areaM2, climate) {
  const coolDeltaT = Math.max(climate.summerAvg - climate.coolSet, 0);
  const conduction = u * areaM2 * coolDeltaT;
  const solar = shgc * areaM2 * climate.solarAvg;
  const coolingW = conduction + solar;
  const heatDeltaT = Math.max(climate.heatSet - climate.winterAvg, 0);
  const heatingW = u * areaM2 * heatDeltaT;
  return { coolingW, heatingW };
}

function annualEnergy(u, shgc, areaM2, climate, usage, hvac) {
  const peak = peakLoad(u, shgc, areaM2, climate);
  const avg = avgLoad(u, shgc, areaM2, climate);
  const coolThermalKwh = (avg.coolingW * climate.coolHours * usage.cool) / 1000;
  const heatThermalKwh = (avg.heatingW * climate.heatHours * usage.heat) / 1000;
  const coolElecKwh = coolThermalKwh / hvac.coolingCOP;
  const heatElecKwh = heatThermalKwh / hvac.heatingCOP;
  return { peak, coolElecKwh, heatElecKwh, totalElecKwh: coolElecKwh + heatElecKwh };
}

function cumulativeSeries(initialInvestment, annualCost, escalation, years) {
  const series = [];
  let cumulative = initialInvestment, price = annualCost;
  for (let y = 1; y <= years; y++) {
    cumulative += price;
    series.push({ year: y, cost: cumulative });
    price *= 1 + escalation;
  }
  return series;
}

function findBreakEven(baselineSeries, improvedSeries) {
  for (let i = 0; i < baselineSeries.length; i++) {
    if (improvedSeries[i].cost <= baselineSeries[i].cost) return baselineSeries[i].year;
  }
  return null;
}

function windowShareOfTotalUA(windowU, wallU, roofU, areaM2, assumptions) {
  const windowUA = windowU * areaM2;
  const wallUA = wallU * areaM2 * assumptions.wallAreaPerWindowM2;
  const roofUA = roofU * areaM2 * assumptions.roofAreaPerWindowM2;
  const total = windowUA + wallUA + roofUA;
  return total > 0 ? windowUA / total : 0;
}

function calculate({ config, areaM2, climate, building, usage, glazing, econPrice }) {
  if (!areaM2 || areaM2 <= 0) return null;
  const hvac = config.hvac;
  const alu = config.aluminium;

  const baseEnergy = annualEnergy(alu.u, alu.shgc, areaM2, climate, usage, hvac);
  const impEnergy = annualEnergy(glazing.u, glazing.shgc, areaM2, climate, usage, hvac);

  const econ = { price: econPrice, escalation: config.econ.escalation, years: config.econ.years };
  const baseCost = baseEnergy.totalElecKwh * econ.price;
  const impCost = impEnergy.totalElecKwh * econ.price;
  const annualSavings = baseCost - impCost;

  const additionalInvestment = areaM2 * (glazing.price - alu.price);
  const paybackYears = annualSavings > 0 ? additionalInvestment / annualSavings : null;

  const baseSeries = cumulativeSeries(areaM2 * alu.price, baseCost, econ.escalation, econ.years);
  const impSeries = cumulativeSeries(areaM2 * glazing.price, impCost, econ.escalation, econ.years);
  const breakEvenYear = annualSavings > 0 ? findBreakEven(baseSeries, impSeries) : null;

  const savingsAt = (n) => {
    const b = baseSeries.find((p) => p.year === n), i = impSeries.find((p) => p.year === n);
    return b && i ? b.cost - i.cost : null;
  };

  const coolingReductionBtu = baseEnergy.peak.coolingBtuH - impEnergy.peak.coolingBtuH;
  const heatingReductionBtu = baseEnergy.peak.heatingBtuH - impEnergy.peak.heatingBtuH;
  const coolingKwhYear = baseEnergy.coolElecKwh - impEnergy.coolElecKwh;
  const heatingKwhYear = baseEnergy.heatElecKwh - impEnergy.heatElecKwh;

  const heatGainReductionPct = baseEnergy.peak.coolingW > 0
    ? Math.max(0, (baseEnergy.peak.coolingW - impEnergy.peak.coolingW) / baseEnergy.peak.coolingW) * 100
    : null;

  const windowShare = windowShareOfTotalUA(glazing.u, building.wallU, building.roofU, areaM2, config.assumptions);
  const tempCentral = (heatGainReductionPct / 100) * windowShare * config.assumptions.maxSwingC;
  const tempRange = [Math.round(tempCentral * 0.8 * 10) / 10, Math.round(tempCentral * 1.2 * 10) / 10];

  return {
    baseline: { name: alu.name, coolElecKwh: baseEnergy.coolElecKwh, heatElecKwh: baseEnergy.heatElecKwh, cost: baseCost, coolingBtuH: baseEnergy.peak.coolingBtuH, heatingBtuH: baseEnergy.peak.heatingBtuH },
    improved: { coolElecKwh: impEnergy.coolElecKwh, heatElecKwh: impEnergy.heatElecKwh, cost: impCost, coolingBtuH: impEnergy.peak.coolingBtuH, heatingBtuH: impEnergy.peak.heatingBtuH },
    annualSavings, additionalInvestment, paybackYears, breakEvenYear,
    fiveYear: savingsAt(5), tenYear: savingsAt(10), fifteenYear: savingsAt(Math.min(15, econ.years)),
    coolingReductionBtu, heatingReductionBtu, coolingKwhYear, heatingKwhYear,
    heatGainReductionPct, tempRange,
    chartData: baseSeries.map((p, i) => ({ year: p.year, Aluminium: Math.round(p.cost), Fenestra: Math.round(impSeries[i].cost) })),
    modelVersion: MODEL_VERSION,
  };
}

/* ============================================================
   FORMATTING HELPERS
   ============================================================ */

const fmtUSD0 = (n) => (n == null ? "—" : `$${Math.round(Math.abs(n)).toLocaleString()}`);
const fmtBTU = (n) => (n == null ? "—" : `${Math.round(Math.abs(n)).toLocaleString()} BTU/h`);
const fmtKwh = (n) => (n == null ? "—" : `${Math.abs(n).toFixed(0)} kWh`);
const fmtYears = (n) => (n == null ? "Not reached under current assumptions" : `≈ ${n.toFixed(1)} years`);
const sign = (n) => (n > 0.005 ? "+" : n < -0.005 ? "−" : "");

/* ============================================================
   STYLE TOKENS -- aligned with fenestra.co (clean, white, navy text,
   single steel-blue accent, villa-photography brand tone)
   ============================================================ */

const S = {
  paper: "#FFFFFF",
  section: "#F5F6F3",
  ink: "#152029",
  inkSoft: "#5B6970",
  accent: "#1F6E8C",
  accentDark: "#154F63",
  accentLight: "#E8F2F5",
  line: "#E2E4DF",
  good: "#1E7B4D",
  goodBg: "#EAF7EF",
  bad: "#B23A2E",
  badBg: "#FCEBE9",
  gold: "#AD8A54",
};

function GlobalStyle() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
      .fen-root { font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; color: ${S.ink}; background: ${S.paper}; }
      .fen-card { background: ${S.paper}; border: 1px solid ${S.line}; }
      .fen-section { background: ${S.section}; }
      .fen-btn-primary { background: ${S.ink}; color: #fff; transition: background .15s ease; }
      .fen-btn-primary:hover { background: ${S.accentDark}; }
      .fen-btn-primary:disabled { opacity: .35; }
      .fen-btn-primary:focus-visible, .fen-choice:focus-visible, .fen-tab:focus-visible { outline: 2px solid ${S.accent}; outline-offset: 2px; }
      .fen-choice { border: 1px solid ${S.line}; background: ${S.paper}; transition: border-color .15s ease, background .15s ease; text-align: left; }
      .fen-choice:hover:not(:disabled) { border-color: ${S.accent}; }
      .fen-choice.selected { border-color: ${S.accent}; background: ${S.accentLight}; }
      .fen-choice:disabled { opacity: .45; cursor: not-allowed; }
      .fen-hairline { border-color: ${S.line}; }
      .fen-num { font-variant-numeric: tabular-nums; }
      input[type=range].fen-slider { accent-color: ${S.accent}; }
      .fen-good { color: ${S.good}; }
      .fen-bad { color: ${S.bad}; }
      .fen-toggle { width: 40px; height: 22px; border-radius: 999px; position: relative; transition: background .15s; flex-shrink: 0; }
      .fen-toggle-dot { width: 18px; height: 18px; border-radius: 999px; background: #fff; position: absolute; top: 2px; transition: left .15s; }
      @media (prefers-reduced-motion: reduce) { .fen-root * { transition: none !important; animation: none !important; } }
    `}</style>
  );
}

/* ============================================================
   INFO TOOLTIP -- closes on outside click, not only on re-click
   ============================================================ */

function InfoTip({ children }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <span className="relative inline-block" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} aria-label="More information" className="align-middle ml-1" style={{ color: S.accent }}>
        <Info size={14} />
      </button>
      {open && (
        <span className="absolute z-20 left-0 top-6 w-64 text-xs rounded-md p-3 fen-card shadow-lg" style={{ color: S.inkSoft }}>
          {children}
        </span>
      )}
    </span>
  );
}

/* ============================================================
   NUMBER INPUT + SLIDER PAIR (manual typing always allowed)
   ============================================================ */

function NumberSlider({ label, value, onChange, min, max, step = 1, unit, decimals = 0 }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm" style={{ color: S.inkSoft }}>{label}</span>
        <span className="flex items-center gap-1">
          <input
            type="number" min={min} max={max} step={step} value={value}
            onChange={(e) => {
              const v = Number(e.target.value);
              onChange(Math.min(max, Math.max(min, isNaN(v) ? min : v)));
            }}
            className="fen-num w-20 text-right border rounded px-1.5 py-0.5 text-sm fen-hairline focus:outline-none"
            style={{ borderColor: S.line }}
          />
          <span className="text-xs" style={{ color: S.inkSoft }}>{unit}</span>
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} className="fen-slider w-full"
        onChange={(e) => onChange(Number(e.target.value))} />
      <div className="flex justify-between text-xs mt-0.5" style={{ color: S.inkSoft }}>
        <span>{min}{unit}</span><span>{max}{unit}</span>
      </div>
    </div>
  );
}

function ToggleSwitch({ checked, onChange, disabled, label, note }) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className="flex items-center gap-3 w-full text-left py-2 disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <span className="fen-toggle" style={{ background: checked ? S.accent : S.line }}>
        <span className="fen-toggle-dot" style={{ left: checked ? "20px" : "2px" }} />
      </span>
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {note && <span className="block text-xs" style={{ color: S.inkSoft }}>{note}</span>}
      </span>
    </button>
  );
}

/* ============================================================
   NAV / HEADER -- echoes fenestra.co's real nav treatment
   ============================================================ */

function Nav({ screen, setScreen }) {
  const NavLink = ({ id, children }) => (
    <button onClick={() => setScreen(id)}
      className="text-sm font-medium px-1"
      style={{ color: screen === id ? S.ink : S.inkSoft, borderBottom: screen === id ? `2px solid ${S.accent}` : "2px solid transparent" }}>
      {children}
    </button>
  );
  return (
    <div className="flex items-center justify-between mb-10 pb-4 border-b fen-hairline">
      <button onClick={() => setScreen("landing")} className="flex items-center gap-2">
        <div className="w-6 h-6 rounded-sm" style={{ background: S.accent }} />
        <span className="font-extrabold tracking-tight">Fenestra</span>
        <span className="text-sm" style={{ color: S.inkSoft }}>/ Window performance &amp; ROI</span>
      </button>
      <div className="hidden sm:flex items-center gap-6">
        <NavLink id="wizard">Quick estimate</NavLink>
        <NavLink id="methodology">Learn the science</NavLink>
        <span className="text-sm px-3 py-1.5 rounded-full" style={{ background: S.ink, color: "#fff" }}>Request a quote</span>
      </div>
    </div>
  );
}

/* ============================================================
   HERO CROSS-SECTION DIAGRAM
   ============================================================ */

function WindowCrossSection() {
  return (
    <svg viewBox="0 0 520 200" className="w-full h-auto" role="img" aria-label="Cross-section comparing heat passing through a standard pane versus a Fenestra pane">
      <rect x="0" y="0" width="520" height="200" fill={S.section} />
      <circle cx="70" cy="42" r="18" fill={S.gold} opacity="0.9" />
      {[...Array(7)].map((_, i) => {
        const angle = (i / 7) * Math.PI * 1.4 - 0.5;
        const x1 = 70 + Math.cos(angle) * 25, y1 = 42 + Math.sin(angle) * 25;
        const x2 = 70 + Math.cos(angle) * 36, y2 = 42 + Math.sin(angle) * 36;
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={S.gold} strokeWidth="2" opacity="0.6" />;
      })}
      <g>
        <rect x="150" y="18" width="10" height="164" fill={S.inkSoft} />
        <rect x="160" y="26" width="6" height="148" fill="#D8E4E6" opacity="0.7" />
        <path d="M 92 42 L 163 92" stroke={S.gold} strokeWidth="2.5" strokeDasharray="4 4" fill="none" />
        <path d="M 175 92 L 250 128" stroke={S.gold} strokeWidth="2.5" strokeDasharray="4 4" fill="none" />
        <text x="118" y="196" fontSize="12" fill={S.inkSoft} fontFamily="Inter">Standard aluminium</text>
      </g>
      <g>
        <rect x="330" y="18" width="14" height="164" fill={S.accentDark} />
        <rect x="344" y="24" width="4" height="152" fill="#C7DEE2" />
        <rect x="352" y="24" width="4" height="152" fill="#C7DEE2" opacity="0.6" />
        <path d="M 270 42 L 342 92" stroke={S.gold} strokeWidth="2.5" strokeDasharray="4 4" fill="none" />
        <path d="M 342 92 L 356 100" stroke={S.accent} strokeWidth="2.5" fill="none" />
        <circle cx="358" cy="102" r="4" fill={S.accent} />
        <text x="300" y="196" fontSize="12" fill={S.inkSoft} fontFamily="Inter">Fenestra PVC</text>
      </g>
    </svg>
  );
}

/* ============================================================
   WIZARD
   ============================================================ */

const STEPS = ["area", "location", "building", "usage", "configure"];

function ChoiceCard({ selected, onClick, title, desc, icon }) {
  return (
    <button onClick={onClick} className={`fen-choice w-full text-left rounded-lg p-4 flex items-start gap-3 ${selected ? "selected" : ""}`}>
      {icon && <span className="mt-0.5" style={{ color: selected ? S.accent : S.inkSoft }}>{icon}</span>}
      <span>
        <span className="block font-medium">{title}</span>
        {desc && <span className="block text-sm mt-0.5" style={{ color: S.inkSoft }}>{desc}</span>}
      </span>
      {selected && <CircleCheck size={18} className="ml-auto flex-shrink-0" style={{ color: S.accent }} />}
    </button>
  );
}

function StepRail({ stepIndex }) {
  return (
    <div className="flex items-center gap-1.5 mb-6" aria-hidden="true">
      {STEPS.map((s, i) => <div key={s} className="h-1 rounded-full flex-1" style={{ background: i <= stepIndex ? S.accent : S.line }} />)}
    </div>
  );
}

function GlazingConfigurator({ config, state, setState }) {
  const layers = state.glazingLayers;
  const isSingle = layers === "single";
  const glazing = getGlazing(config, layers, isSingle ? false : state.lowE, isSingle ? false : state.argon);

  return (
    <div>
      <h2 className="text-2xl font-bold mb-1">Configure your PVC windows</h2>
      <p className="text-sm mb-5" style={{ color: S.inkSoft }}>
        Starting from our Standard PVC configuration. Add features to see the performance and price change live.
        We'll compare this against standard aluminium.
      </p>

      <div className="fen-card rounded-lg p-5 mb-4">
        <div className="text-xs font-medium mb-2" style={{ color: S.inkSoft }}>Glazing</div>
        <div className="grid grid-cols-3 gap-2 mb-4">
          {["single", "double", "triple"].map((l) => (
            <button key={l} onClick={() => setState((s) => ({ ...s, glazingLayers: l, ...(l === "single" ? { lowE: false, argon: false } : {}) }))}
              className={`fen-choice rounded-lg py-2.5 text-sm font-medium capitalize ${layers === l ? "selected" : ""}`}>
              {l}
            </button>
          ))}
        </div>
        <div className="border-t fen-hairline pt-3 space-y-1">
          <ToggleSwitch checked={!isSingle && state.lowE} disabled={isSingle}
            onChange={(v) => setState((s) => ({ ...s, lowE: v }))}
            label="Low-E coating" note={isSingle ? "Available with double or triple glazing" : "Cuts solar heat gain significantly — the biggest lever for cooling"} />
          <ToggleSwitch checked={!isSingle && state.argon} disabled={isSingle}
            onChange={(v) => setState((s) => ({ ...s, argon: v }))}
            label="Argon fill" note={isSingle ? "Available with double or triple glazing" : "Improves insulation between panes"} />
        </div>
      </div>

      <div className="fen-card rounded-lg p-5 mb-4" style={{ background: S.accentLight, borderColor: S.accent }}>
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-xs font-medium" style={{ color: S.accentDark }}>Your configuration</div>
            <div className="font-semibold">
              {layers.charAt(0).toUpperCase() + layers.slice(1)} glazing
              {glazing.lowE ? " + Low-E" : ""}{glazing.argon ? " + Argon" : ""}
            </div>
          </div>
          <div className="text-right">
            <div className="fen-num text-xl font-bold" style={{ color: S.accentDark }}>≈ ${glazing.price}/m²</div>
            <div className="text-xs" style={{ color: S.inkSoft }}>U {glazing.u} W/m²K · SHGC {glazing.shgc}</div>
          </div>
        </div>
      </div>

      <div className="text-xs rounded-lg p-3 fen-hairline border" style={{ color: S.inkSoft }}>
        <strong style={{ color: S.ink }}>Rough estimate only: </strong>
        Standard aluminium ≈ ${config.aluminium.price}/m². Standard PVC (double glazing) ≈ ${config.glazingBasePrice.double}/m².
        Low-E adds ≈ ${config.lowEAdder}/m², Argon adds ≈ ${config.argonAdder}/m², triple glazing's own base price already
        reflects its extra pane. These figures are indicative, supplied-and-installed placeholders, not a current
        price list — they vary by project, opening size, hardware and finish. Please request a quote for accurate
        pricing on your specific project.
      </div>
    </div>
  );
}

function QuickEstimateWizard({ config, state, setState, onCalculate }) {
  const [stepIndex, setStepIndex] = useState(0);
  const step = STEPS[stepIndex];
  const next = () => setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
  const back = () => setStepIndex((i) => Math.max(i - 1, 0));

  const canProceed = () => {
    if (step === "area") return state.areaM2 > 0;
    if (step === "location") return !!state.climateId;
    if (step === "building") return !!state.buildingId;
    if (step === "usage") return !!state.usageId;
    return true;
  };

  return (
    <div className="max-w-md mx-auto">
      <StepRail stepIndex={stepIndex} />

      {step === "area" && (
        <div>
          <h2 className="text-2xl font-bold mb-1">How much window area does your home have?</h2>
          <p className="text-sm mb-6" style={{ color: S.inkSoft }}>If you're not sure, your best estimate is fine.</p>
          <div className="fen-card rounded-lg p-6">
            <NumberSlider label="Window area" value={state.areaM2}
              onChange={(v) => setState((s) => ({ ...s, areaM2: v }))}
              min={config.bounds.areaMin} max={config.bounds.areaMax} unit=" m²" />
          </div>
        </div>
      )}

      {step === "location" && (
        <div>
          <h2 className="text-2xl font-bold mb-1">Where is the building?</h2>
          <p className="text-sm mb-6" style={{ color: S.inkSoft }}>This sets the climate assumptions behind your estimate.</p>
          <div className="grid gap-3">
            {Object.values(config.climates).map((c) => (
              <ChoiceCard key={c.id} selected={state.climateId === c.id} onClick={() => setState((s) => ({ ...s, climateId: c.id }))}
                title={c.name} desc={c.examples} icon={<MapPin size={18} />} />
            ))}
          </div>
        </div>
      )}

      {step === "building" && (
        <div>
          <h2 className="text-2xl font-bold mb-1">How well insulated is the building?</h2>
          <p className="text-sm mb-6" style={{ color: S.inkSoft }}>A rough sense of the walls and roof is enough.</p>
          <div className="grid gap-3">
            {Object.values(config.buildings).map((b) => (
              <ChoiceCard key={b.id} selected={state.buildingId === b.id} onClick={() => setState((s) => ({ ...s, buildingId: b.id }))}
                title={b.name} desc={b.desc} icon={<Home size={18} />} />
            ))}
          </div>
        </div>
      )}

      {step === "usage" && (
        <div>
          <h2 className="text-2xl font-bold mb-1">How do you use cooling and heating?</h2>
          <p className="text-sm mb-6" style={{ color: S.inkSoft }}>This shapes how much of the year HVAC is actually running.</p>
          <div className="grid gap-3">
            {Object.values(config.usage).map((u) => (
              <ChoiceCard key={u.id} selected={state.usageId === u.id} onClick={() => setState((s) => ({ ...s, usageId: u.id }))}
                title={u.name} desc={u.hours} icon={<ThermometerSun size={18} />} />
            ))}
          </div>
        </div>
      )}

      {step === "configure" && <GlazingConfigurator config={config} state={state} setState={setState} />}

      <div className="flex items-center justify-between mt-8">
        <button onClick={back} disabled={stepIndex === 0} className="flex items-center gap-1 text-sm disabled:opacity-0" style={{ color: S.inkSoft }}>
          <ChevronLeft size={16} /> Back
        </button>
        {stepIndex < STEPS.length - 1 ? (
          <button onClick={next} disabled={!canProceed()} className="fen-btn-primary rounded-full px-6 py-2.5 text-sm font-medium flex items-center gap-1">
            Next <ChevronRight size={16} />
          </button>
        ) : (
          <button onClick={onCalculate} className="fen-btn-primary rounded-full px-6 py-2.5 text-sm font-medium flex items-center gap-1">
            Calculate <ArrowRight size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   RESULTS PIECES
   ============================================================ */

function DeltaStat({ label, value, formatted, tip, goodIsPositive = true }) {
  const isGood = goodIsPositive ? value > 0 : value < 0;
  const isBad = goodIsPositive ? value < 0 : value > 0;
  const color = isGood ? S.good : isBad ? S.bad : S.ink;
  const bg = isGood ? S.goodBg : isBad ? S.badBg : S.section;
  return (
    <div className="fen-card rounded-lg p-5">
      <div className="text-sm flex items-center" style={{ color: S.inkSoft }}>{label}{tip && <InfoTip>{tip}</InfoTip>}</div>
      <div className="fen-num text-3xl font-bold mt-1 inline-flex items-center gap-2 px-2 py-0.5 rounded-md -ml-2" style={{ color, background: value ? bg : "transparent" }}>
        {value ? sign(value) : ""}{formatted}
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, tip }) {
  return (
    <div className="fen-card rounded-lg p-5">
      <div className="text-sm flex items-center" style={{ color: S.inkSoft }}>{label}{tip && <InfoTip>{tip}</InfoTip>}</div>
      <div className="fen-num text-3xl font-bold mt-1">{value}</div>
      {sub && <div className="text-xs mt-1" style={{ color: S.inkSoft }}>{sub}</div>}
    </div>
  );
}

function UnitToggle({ mode, setMode }) {
  const opts = [["btu", "Peak (BTU/h)"], ["kwh_month", "kWh / month"], ["kwh_year", "kWh / year"]];
  return (
    <div className="flex gap-1 mb-3 flex-wrap">
      {opts.map(([id, label]) => (
        <button key={id} onClick={() => setMode(id)}
          className="fen-tab text-xs rounded-full py-1 px-3 border"
          style={{ borderColor: mode === id ? S.accent : S.line, background: mode === id ? S.accentLight : "transparent", color: mode === id ? S.accentDark : S.inkSoft }}>
          {label}
        </button>
      ))}
    </div>
  );
}

function CumulativeCostChart({ data, breakEvenYear }) {
  const breakPoint = data.find((d) => d.year === breakEvenYear);
  return (
    <div className="fen-card rounded-lg p-5">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="font-semibold">Cumulative cost over time</h3>
        {breakEvenYear ? (
          <span className="text-xs fen-good font-medium">Break-even around year {breakEvenYear}</span>
        ) : (
          <span className="text-xs" style={{ color: S.inkSoft }}>Not reached in this window</span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={S.line} vertical={false} />
          <XAxis dataKey="year" tick={{ fontSize: 12, fill: S.inkSoft }} tickLine={false} axisLine={{ stroke: S.line }} label={{ value: "Years", position: "insideBottom", offset: -2, fontSize: 11, fill: S.inkSoft }} />
          <YAxis tick={{ fontSize: 12, fill: S.inkSoft }} tickLine={false} axisLine={false} tickFormatter={(v) => `$${v / 1000}k`} />
          <Tooltip formatter={(v) => `$${v.toLocaleString()}`} contentStyle={{ borderColor: S.line, fontSize: 13, fontFamily: "Inter" }} />
          <Line type="monotone" dataKey="Aluminium" stroke={S.gold} strokeWidth={2.5} dot={false} />
          <Line type="monotone" dataKey="Fenestra" stroke={S.accent} strokeWidth={2.5} dot={false} />
          {breakPoint && <ReferenceDot x={breakPoint.year} y={breakPoint.Fenestra} r={5} fill={S.accent} stroke={S.paper} strokeWidth={2} />}
        </LineChart>
      </ResponsiveContainer>
      <div className="flex gap-4 mt-2 text-xs" style={{ color: S.inkSoft }}>
        <span className="flex items-center gap-1.5"><span className="w-3 h-0.5" style={{ background: S.gold }} /> Standard aluminium</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-0.5" style={{ background: S.accent }} /> Fenestra</span>
      </div>
    </div>
  );
}

function WhyPVC() {
  const items = [
    { icon: <ShieldCheck size={18} />, title: "Doesn't corrode in salt air", body: "Coastal humidity and salt spray degrade aluminium finishes over time. PVC frames don't corrode." },
    { icon: <Volume2 size={18} />, title: "Quieter", body: "Multi-chamber PVC profiles typically outperform aluminium for sound insulation." },
    { icon: <Clock size={18} />, title: "40+ year lifespan, no repainting", body: "No anodizing or paint to maintain — one less recurring cost over the life of the window." },
    { icon: <Lock size={18} />, title: "Multi-point locking available", body: "PVC frame profiles readily accommodate reinforced, multi-point door and window locking hardware." },
  ];
  return (
    <div className="grid sm:grid-cols-2 gap-3">
      {items.map((it, i) => (
        <div key={i} className="fen-card rounded-lg p-4 flex gap-3">
          <span className="mt-0.5" style={{ color: S.accent }}>{it.icon}</span>
          <span>
            <span className="block text-sm font-semibold">{it.title}</span>
            <span className="block text-xs mt-0.5" style={{ color: S.inkSoft }}>{it.body}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function EquationBlock({ title, formula, terms }) {
  return (
    <div className="fen-hairline border rounded-lg p-4">
      <div className="text-sm font-medium mb-2">{title}</div>
      <div className="text-lg mb-2 font-mono" style={{ color: S.accentDark }}>{formula}</div>
      <ul className="text-xs space-y-0.5" style={{ color: S.inkSoft }}>{terms.map((t, i) => <li key={i}>{t}</li>)}</ul>
    </div>
  );
}

function AdvancedPanel({ config, adminConfig, state, setState, climate, glazing }) {
  const [open, setOpen] = useState(false);
  const [customInsulation, setCustomInsulation] = useState(false);
  const building = config.buildings[state.buildingId];
  const effectiveWallU = customInsulation ? state.customWallU : building.wallU;
  const effectiveRoofU = customInsulation ? state.customRoofU : building.roofU;

  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} className="text-sm font-medium flex items-center gap-1.5 mx-auto" style={{ color: S.accentDark }}>
        <Settings2 size={15} /> {open ? "Hide" : "Explore"} advanced analysis
      </button>

      {open && (
        <div className="mt-6 fen-card rounded-lg p-6 text-left max-w-2xl mx-auto space-y-6">
          <div>
            <h3 className="text-lg font-semibold mb-1">Advanced analysis</h3>
            <p className="text-sm" style={{ color: S.inkSoft }}>
              Every variable behind this estimate, editable within safe bounds so the model can't be broken.
              Calculation model v{MODEL_VERSION}.
            </p>
          </div>

          <div>
            <div className="text-xs font-medium mb-2" style={{ color: S.inkSoft }}>Climate — {climate.name}</div>
            <div className="grid sm:grid-cols-2 gap-3 text-sm">
              <NumberSlider label="Summer design temp (peak)" value={state.climateOverrides.summerDesign ?? climate.summerDesign}
                onChange={(v) => setState((s) => ({ ...s, climateOverrides: { ...s.climateOverrides, summerDesign: v } }))}
                min={25} max={45} unit="°C" />
              <NumberSlider label="Summer average temp" value={state.climateOverrides.summerAvg ?? climate.summerAvg}
                onChange={(v) => setState((s) => ({ ...s, climateOverrides: { ...s.climateOverrides, summerAvg: v } }))}
                min={18} max={38} unit="°C" />
              <NumberSlider label="Winter design temp (cold snap)" value={state.climateOverrides.winterDesign ?? climate.winterDesign}
                onChange={(v) => setState((s) => ({ ...s, climateOverrides: { ...s.climateOverrides, winterDesign: v } }))}
                min={-10} max={15} unit="°C" />
              <NumberSlider label="Peak solar irradiance" value={state.climateOverrides.solarPeak ?? climate.solarPeak}
                onChange={(v) => setState((s) => ({ ...s, climateOverrides: { ...s.climateOverrides, solarPeak: v } }))}
                min={100} max={600} unit=" W/m²" />
            </div>
            <p className="text-xs mt-2" style={{ color: S.inkSoft }}>
              Design (peak) values drive the BTU/h load figure; average values drive annual energy — these are
              deliberately kept separate rather than reusing a worst-case temperature for a full-year estimate.
            </p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-medium" style={{ color: S.inkSoft }}>Building insulation — {building.name}</div>
              <label className="text-xs flex items-center gap-1.5" style={{ color: S.accentDark }}>
                <input type="checkbox" checked={customInsulation} onChange={(e) => setCustomInsulation(e.target.checked)} /> Enter my own values
              </label>
            </div>
            {customInsulation ? (
              <div className="grid sm:grid-cols-2 gap-3">
                <NumberSlider label="Wall U-value" value={state.customWallU} onChange={(v) => setState((s) => ({ ...s, customWallU: v }))}
                  min={config.bounds.wallUMin} max={config.bounds.wallUMax} step={0.05} unit=" W/m²K" />
                <NumberSlider label="Roof U-value" value={state.customRoofU} onChange={(v) => setState((s) => ({ ...s, customRoofU: v }))}
                  min={config.bounds.roofUMin} max={config.bounds.roofUMax} step={0.05} unit=" W/m²K" />
              </div>
            ) : (
              <div className="text-sm" style={{ color: S.inkSoft }}>Wall U ≈ {building.wallU} W/m²K · Roof U ≈ {building.roofU} W/m²K</div>
            )}
          </div>

          <div>
            <div className="text-xs font-medium mb-2" style={{ color: S.inkSoft }}>HVAC &amp; economics</div>
            <div className="grid sm:grid-cols-2 gap-3">
              <NumberSlider label="Cooling COP" value={state.hvacOverrides.coolingCOP ?? config.hvac.coolingCOP}
                onChange={(v) => setState((s) => ({ ...s, hvacOverrides: { ...s.hvacOverrides, coolingCOP: v } }))} min={1.5} max={5} step={0.1} unit="" />
              <NumberSlider label="Heating COP" value={state.hvacOverrides.heatingCOP ?? config.hvac.heatingCOP}
                onChange={(v) => setState((s) => ({ ...s, hvacOverrides: { ...s.hvacOverrides, heatingCOP: v } }))} min={1.5} max={5} step={0.1} unit="" />
            </div>
          </div>

          <div>
            <div className="text-xs font-medium mb-2" style={{ color: S.inkSoft }}>Product properties</div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="fen-hairline border rounded-md p-2">
                <div className="font-medium">{config.aluminium.name}</div>
                <div style={{ color: S.inkSoft }}>U = {config.aluminium.u} W/m²K · SHGC = {config.aluminium.shgc}</div>
              </div>
              <div className="fen-hairline border rounded-md p-2">
                <div className="font-medium">Your configuration</div>
                <div style={{ color: S.inkSoft }}>U = {glazing.u} W/m²K · SHGC = {glazing.shgc}</div>
              </div>
            </div>
          </div>

          <div className="grid gap-3">
            <EquationBlock title="Conductive heat transfer" formula="Q = U × A × ΔT"
              terms={[`U = window thermal transmittance (W/m²K)`, `A = ${state.areaM2} m² (window area)`, `ΔT = indoor/outdoor temperature difference`]} />
            <EquationBlock title="Solar heat gain" formula="Q = SHGC × A × Solar Irradiance"
              terms={[`SHGC = solar heat gain coefficient`, `Solar irradiance from selected climate profile (design or average)`]} />
            <EquationBlock title="HVAC electrical energy" formula="Electrical Energy = Thermal Energy / COP"
              terms={[`Cooling COP = ${state.hvacOverrides.coolingCOP ?? config.hvac.coolingCOP}`, `Heating COP = ${state.hvacOverrides.heatingCOP ?? config.hvac.heatingCOP}`]} />
          </div>

          <div>
            <div className="text-xs font-medium mb-2" style={{ color: S.inkSoft }}>Sources</div>
            <ul className="text-xs space-y-1" style={{ color: S.inkSoft }}>
              <li>ASHRAE Handbook — fenestration U-factor and SHGC methodology</li>
              <li>ISO 10077-1:2017 — thermal performance of windows and doors</li>
              <li>Lebanese residential building energy study — baseline envelope and setpoint values</li>
              <li>Fenestra published product claims (fenestra.co) — U-value from 0.8 W/m²K, 45dB sound reduction, salt-air resistance</li>
              <li>Typical published performance ranges for double/triple Low-E/Argon PVC glazing (provisional)</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   RESULTS SCREEN
   ============================================================ */

function ResultsScreen({ config, state, setState, onRestart }) {
  const climate = { ...config.climates[state.climateId], ...state.climateOverrides };
  const building = config.buildings[state.buildingId];
  const usage = config.usage[state.usageId];
  const effBuilding = state.customWallU != null && state.customRoofU != null
    ? { ...building, wallU: state.customWallU, roofU: state.customRoofU } : building;
  const glazing = getGlazing(config, state.glazingLayers, state.glazingLayers === "single" ? false : state.lowE, state.glazingLayers === "single" ? false : state.argon);
  const effHvac = { coolingCOP: state.hvacOverrides.coolingCOP ?? config.hvac.coolingCOP, heatingCOP: state.hvacOverrides.heatingCOP ?? config.hvac.heatingCOP };
  const effConfig = { ...config, hvac: effHvac };

  const [unitMode, setUnitMode] = useState("btu");

  const result = useMemo(() => calculate({
    config: effConfig, areaM2: state.areaM2, climate, building: effBuilding, usage, glazing, econPrice: state.econPrice,
  }), [effConfig, state.areaM2, climate, effBuilding, usage, glazing, state.econPrice]);

  if (!result) return null;

  const configLabel = `${state.glazingLayers.charAt(0).toUpperCase() + state.glazingLayers.slice(1)}${glazing.lowE ? " + Low-E" : ""}${glazing.argon ? " + Argon" : ""}`;

  const coolingDisplay = unitMode === "btu" ? fmtBTU(result.coolingReductionBtu)
    : unitMode === "kwh_month" ? `${fmtKwh(result.coolingKwhYear / 12)}/mo` : `${fmtKwh(result.coolingKwhYear)}/yr`;
  const heatingDisplay = unitMode === "btu" ? fmtBTU(result.heatingReductionBtu)
    : unitMode === "kwh_month" ? `${fmtKwh(result.heatingKwhYear / 12)}/mo` : `${fmtKwh(result.heatingKwhYear)}/yr`;

  return (
    <div className="max-w-3xl mx-auto">
      <div className="text-center mb-8">
        <div className="text-sm mb-1" style={{ color: S.inkSoft }}>
          {state.areaM2} m² · {climate.name} · {building.name} · {usage.name} · {configLabel}
        </div>
        <h2 className="text-3xl font-bold">Your estimated results</h2>
      </div>

      <div className="grid sm:grid-cols-3 gap-4 mb-6">
        <DeltaStat label="Estimated annual savings" value={result.annualSavings} formatted={fmtUSD0(result.annualSavings)}
          tip="Baseline annual window-related electricity cost minus your configuration's cost." />
        <StatCard label="Estimated payback" value={fmtYears(result.paybackYears)}
          tip="Additional window investment divided by annual energy savings. A long or unreached payback reflects electricity savings only — it excludes comfort, noise, and durability value." />
        <DeltaStat label={`${Math.min(10, config.econ.years)}-year potential savings`} value={result.tenYear ?? 0} formatted={result.tenYear != null ? fmtUSD0(result.tenYear) : "—"}
          tip="Cumulative ownership cost difference at year 10, including energy price escalation. A negative figure means the upfront cost hasn't been recovered by year 10 through electricity savings alone." />
      </div>

      <div className="fen-card rounded-lg p-5 mb-6">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
          <h3 className="font-semibold">Cooling &amp; heating load reduction</h3>
          <UnitToggle mode={unitMode} setMode={setUnitMode} />
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <div className="text-sm" style={{ color: S.inkSoft }}>Cooling</div>
            <div className="fen-num text-2xl font-bold fen-good">−{coolingDisplay}</div>
          </div>
          <div>
            <div className="text-sm" style={{ color: S.inkSoft }}>Heating</div>
            <div className="fen-num text-2xl font-bold fen-good">−{heatingDisplay}</div>
          </div>
        </div>
        <p className="text-xs mt-2" style={{ color: S.inkSoft }}>
          "Peak" reflects the window's contribution on a hot/cold design day — not a full HVAC sizing calculation.
          kWh figures are estimated annual/monthly energy under your selected usage.
        </p>
      </div>

      <div className="grid sm:grid-cols-2 gap-4 mb-6">
        <StatCard label="Heat-gain reduction" value={result.heatGainReductionPct != null ? `${Math.round(result.heatGainReductionPct)}%` : "—"}
          sub="Estimated reduction in window-related heat gain" />
        <StatCard label="Estimated temperature stability benefit" value={`≈ ${result.tempRange[0]}–${result.tempRange[1]}°C`}
          sub="Illustrative, under selected assumptions — not a guarantee"
          tip="A simplified estimate of how much steadier indoor temperature could feel, based on the share of your home's heat loss that windows represent. Not a validated room-by-room simulation." />
      </div>

      <div className="mb-6"><CumulativeCostChart data={result.chartData} breakEvenYear={result.breakEvenYear} /></div>

      <div className="mb-6">
        <h3 className="font-semibold mb-3 flex items-center gap-2"><Sparkles size={16} style={{ color: S.accent }} /> Why PVC, beyond the electricity bill</h3>
        <WhyPVC />
      </div>

      <div className="fen-card rounded-lg p-5 mb-8">
        <h3 className="font-semibold mb-4 flex items-center gap-2"><Settings2 size={16} /> What if?</h3>
        <div className="space-y-5">
          <NumberSlider label="Window area" value={state.areaM2} onChange={(v) => setState((s) => ({ ...s, areaM2: v }))}
            min={config.bounds.areaMin} max={config.bounds.areaMax} unit=" m²" />
          <NumberSlider label="Electricity price" value={state.econPrice} onChange={(v) => setState((s) => ({ ...s, econPrice: v }))}
            min={config.bounds.priceMin} max={config.bounds.priceMax} step={0.01} decimals={2} unit=" $/kWh" />
          <div>
            <div className="text-sm mb-2" style={{ color: S.inkSoft }}>Heating &amp; cooling use</div>
            <div className="flex gap-2 flex-wrap">
              {Object.values(config.usage).map((u) => (
                <button key={u.id} onClick={() => setState((s) => ({ ...s, usageId: u.id }))}
                  className="fen-tab text-xs rounded-full py-1.5 px-3 border" title={u.hours}
                  style={{ borderColor: state.usageId === u.id ? S.accent : S.line, background: state.usageId === u.id ? S.accentLight : "transparent", color: state.usageId === u.id ? S.accentDark : S.inkSoft }}>
                  {u.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="text-center mb-6">
        <AdvancedPanel config={config} state={state} setState={setState} climate={climate} glazing={glazing} />
      </div>

      <div className="fen-hairline border-t pt-5 mb-8 text-xs leading-relaxed" style={{ color: S.inkSoft }}>
        <strong style={{ color: S.ink }}>Important: </strong>
        Results are estimates based on the assumptions selected and published engineering relationships. Actual
        building performance depends on construction, installation quality, weather, shading, occupant behaviour
        and HVAC operation. Pricing shown is a rough, indicative placeholder — not a current quote. This calculator
        is intended for comparison, education and demonstration only. It is not a substitute for a professional
        building-energy assessment, HVAC sizing calculation or final quotation. The illustrative temperature
        estimate is a simplified model, not a room-by-room simulation.
      </div>

      <div className="flex flex-col sm:flex-row gap-3 justify-center mb-4">
        <button className="fen-btn-primary rounded-full px-6 py-3 text-sm font-medium">Request a Fenestra quotation</button>
        <button onClick={onRestart} className="rounded-full px-6 py-3 text-sm font-medium fen-hairline border">Start over</button>
      </div>
    </div>
  );
}

/* ============================================================
   LANDING
   ============================================================ */

function StatStrip({ config }) {
  const bestU = Math.min(...Object.values(config.glazingPhysics).map((v) => v[0]));
  return (
    <div className="flex flex-wrap justify-center gap-8 py-6 border-y fen-hairline">
      {[["U-Value from", `${bestU} W/m²K`], ["Sound reduction", "45 dB"], ["Warranty", "10 yrs"]].map(([label, val], i) => (
        <div key={i} className="text-center">
          <div className="text-xs" style={{ color: S.inkSoft }}>{label}</div>
          <div className="text-xl font-bold">{val}</div>
        </div>
      ))}
    </div>
  );
}

function Landing({ config, onStart, setScreen }) {
  return (
    <div className="max-w-2xl mx-auto text-center pt-4 pb-10">
      <div className="max-w-sm mx-auto mb-6"><WindowCrossSection /></div>
      <div className="text-xs font-medium mb-2 tracking-wide" style={{ color: S.accent }}>FENESTRA · BEIRUT</div>
      <h1 className="text-4xl sm:text-5xl font-extrabold leading-tight mb-4">See what better windows could do for your home.</h1>
      <p className="text-base mb-8" style={{ color: S.inkSoft }}>Compare energy use, cooling demand, comfort and long-term cost in less than a minute.</p>
      <div className="flex gap-3 justify-center mb-8 flex-wrap">
        <button onClick={onStart} className="fen-btn-primary rounded-full px-7 py-3.5 text-sm font-medium">Calculate my home</button>
        <button onClick={() => setScreen("methodology")} className="rounded-full px-7 py-3.5 text-sm font-medium fen-hairline border flex items-center gap-2">
          <BookOpen size={16} /> How does it work?
        </button>
      </div>
      <StatStrip config={config} />
    </div>
  );
}

/* ============================================================
   METHODOLOGY / "LEARN THE SCIENCE" PAGE
   ============================================================ */

function Methodology({ setScreen }) {
  const Section = ({ title, children }) => (
    <div className="mb-8">
      <h2 className="text-xl font-bold mb-2">{title}</h2>
      <div className="text-sm leading-relaxed space-y-2" style={{ color: S.inkSoft }}>{children}</div>
    </div>
  );
  return (
    <div className="max-w-2xl mx-auto">
      <button onClick={() => setScreen("landing")} className="flex items-center gap-1 text-sm mb-6" style={{ color: S.inkSoft }}>
        <ArrowLeft size={15} /> Back
      </button>
      <h1 className="text-3xl font-extrabold mb-2">Learn the science</h1>
      <p className="text-sm mb-8" style={{ color: S.inkSoft }}>
        How this calculator estimates window performance, and where the numbers come from.
      </p>

      <Section title="How heat moves through a window">
        <p>Heat gets into (or out of) your home through a window two ways: conduction through the frame and glass,
        and solar radiation passing straight through the glass. We calculate both separately and add them together
        — never a single blended "window heat gain %".</p>
        <p><strong>Conduction:</strong> Q = U × A × ΔT. A lower U-value means less heat passes through for the same
        temperature difference and window area.</p>
        <p><strong>Solar gain:</strong> Q = SHGC × A × Solar Irradiance. A lower SHGC (typically from a Low-E
        coating) means less of the sun's heat makes it through the glass.</p>
      </Section>

      <Section title="Why Low-E and Argon matter">
        <p>Low-E is a microscopically thin coating that reflects infrared heat while still letting visible light
        through — it's the single biggest lever on solar heat gain. Argon gas between panes is a better insulator
        than plain air, mainly improving the conductive (U-value) side. In our configuration matrix, going from
        double glazing to double + Low-E roughly halves the solar heat gain coefficient.</p>
      </Section>

      <Section title="Design conditions vs. annual energy">
        <p>We deliberately use two different sets of outdoor conditions. A "design" or peak condition (like a hot
        summer afternoon) tells you the window's maximum contribution to cooling load — shown as an estimated
        BTU/h figure. An "average" seasonal condition, which is milder, is what actually drives your annual energy
        use. Using the peak condition for a full year's energy estimate would substantially overstate how much
        energy you actually use, so we keep the two separate.</p>
      </Section>

      <Section title="What the temperature estimate is (and isn't)">
        <p>The "estimated temperature stability benefit" is an illustrative estimate, not a room-by-room
        simulation. It looks at how much of your home's total heat-loss coefficient the windows represent —
        relative to your walls and roof — and scales the window heat-gain reduction by that share. A better
        insulated home (lower wall/roof U-values) will show a larger benefit from window upgrades in this model,
        because windows become relatively more significant once everything else is already efficient.</p>
      </Section>

      <Section title="Limitations">
        <p>This is a comparison and education tool, not a certified engineering simulation. It does not model
        hourly weather, window orientation, shading, or your specific floor plan. Product U-values, SHGC and
        pricing shown are provisional reference values pending Fenestra's confirmation of exact configurations.
        For a binding number, request a quote for your specific project.</p>
      </Section>

      <Section title="Sources">
        <ul className="list-disc pl-5 space-y-1">
          <li>ASHRAE Handbook — Fundamentals (fenestration U-factor and SHGC methodology)</li>
          <li>ISO 10077-1:2017 — Thermal performance of windows, doors and shutters</li>
          <li>Lebanese residential building energy study (baseline envelope and setpoint assumptions)</li>
          <li>Fenestra published product claims (fenestra.co)</li>
        </ul>
      </Section>
    </div>
  );
}

/* ============================================================
   ADMIN (demo only — see chat notes on production architecture)
   ============================================================ */

function AdminGate({ config, setConfig, setScreen }) {
  const [code, setCode] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [draft, setDraft] = useState(config);

  if (!unlocked) {
    return (
      <div className="max-w-sm mx-auto text-center pt-16">
        <Lock size={28} className="mx-auto mb-3" style={{ color: S.inkSoft }} />
        <h2 className="text-xl font-bold mb-1">Staff access</h2>
        <p className="text-sm mb-4" style={{ color: S.inkSoft }}>Demo passcode only — not real authentication.</p>
        <input type="password" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Passcode"
          className="border rounded-lg px-3 py-2 text-sm w-full mb-3 fen-hairline" />
        <button onClick={() => code === "fenestra2026" && setUnlocked(true)} className="fen-btn-primary rounded-full px-6 py-2 text-sm">
          Enter
        </button>
        <button onClick={() => setScreen("landing")} className="block mx-auto mt-4 text-xs" style={{ color: S.inkSoft }}>Cancel</button>
      </div>
    );
  }

  const save = () => { setConfig(draft); setScreen("landing"); };

  return (
    <div className="max-w-2xl mx-auto">
      <div className="text-xs rounded-lg p-3 mb-6" style={{ background: S.badBg, color: S.bad }}>
        Demo only. This panel edits values in the browser session and is not secure. A real deployment must move
        this behind server-side authentication (e.g. Django admin), per the original spec.
      </div>
      <h2 className="text-xl font-bold mb-4">Edit underlying variables</h2>

      <div className="fen-card rounded-lg p-5 mb-4">
        <h3 className="font-semibold mb-3">Glazing pricing ($/m²)</h3>
        <div className="grid grid-cols-3 gap-3 mb-3">
          {["single", "double", "triple"].map((l) => (
            <div key={l}>
              <label className="text-xs capitalize block mb-1" style={{ color: S.inkSoft }}>{l} base</label>
              <input type="number" value={draft.glazingBasePrice[l]}
                onChange={(e) => setDraft((d) => ({ ...d, glazingBasePrice: { ...d.glazingBasePrice, [l]: Number(e.target.value) } }))}
                className="border rounded px-2 py-1 w-full fen-hairline text-sm" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs block mb-1" style={{ color: S.inkSoft }}>Low-E adder</label>
            <input type="number" value={draft.lowEAdder} onChange={(e) => setDraft((d) => ({ ...d, lowEAdder: Number(e.target.value) }))} className="border rounded px-2 py-1 w-full fen-hairline text-sm" />
          </div>
          <div>
            <label className="text-xs block mb-1" style={{ color: S.inkSoft }}>Argon adder</label>
            <input type="number" value={draft.argonAdder} onChange={(e) => setDraft((d) => ({ ...d, argonAdder: Number(e.target.value) }))} className="border rounded px-2 py-1 w-full fen-hairline text-sm" />
          </div>
        </div>
      </div>

      <div className="fen-card rounded-lg p-5 mb-4">
        <h3 className="font-semibold mb-3">Aluminium baseline</h3>
        <div className="grid grid-cols-3 gap-3">
          <div><label className="text-xs block mb-1" style={{ color: S.inkSoft }}>U-value</label>
            <input type="number" value={draft.aluminium.u} onChange={(e) => setDraft((d) => ({ ...d, aluminium: { ...d.aluminium, u: Number(e.target.value) } }))} className="border rounded px-2 py-1 w-full fen-hairline text-sm" /></div>
          <div><label className="text-xs block mb-1" style={{ color: S.inkSoft }}>SHGC</label>
            <input type="number" value={draft.aluminium.shgc} onChange={(e) => setDraft((d) => ({ ...d, aluminium: { ...d.aluminium, shgc: Number(e.target.value) } }))} className="border rounded px-2 py-1 w-full fen-hairline text-sm" /></div>
          <div><label className="text-xs block mb-1" style={{ color: S.inkSoft }}>Price/m²</label>
            <input type="number" value={draft.aluminium.price} onChange={(e) => setDraft((d) => ({ ...d, aluminium: { ...d.aluminium, price: Number(e.target.value) } }))} className="border rounded px-2 py-1 w-full fen-hairline text-sm" /></div>
        </div>
      </div>

      <div className="fen-card rounded-lg p-5 mb-6">
        <h3 className="font-semibold mb-3">Economics default</h3>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="text-xs block mb-1" style={{ color: S.inkSoft }}>Default electricity price ($/kWh)</label>
            <input type="number" value={draft.econ.price} onChange={(e) => setDraft((d) => ({ ...d, econ: { ...d.econ, price: Number(e.target.value) } }))} className="border rounded px-2 py-1 w-full fen-hairline text-sm" /></div>
          <div><label className="text-xs block mb-1" style={{ color: S.inkSoft }}>Annual price escalation</label>
            <input type="number" step="0.01" value={draft.econ.escalation} onChange={(e) => setDraft((d) => ({ ...d, econ: { ...d.econ, escalation: Number(e.target.value) } }))} className="border rounded px-2 py-1 w-full fen-hairline text-sm" /></div>
        </div>
      </div>

      <div className="flex gap-3">
        <button onClick={save} className="fen-btn-primary rounded-full px-6 py-2.5 text-sm">Save &amp; apply</button>
        <button onClick={() => setScreen("landing")} className="rounded-full px-6 py-2.5 text-sm fen-hairline border">Discard</button>
      </div>
    </div>
  );
}

/* ============================================================
   APP
   ============================================================ */

const initialWizardState = () => ({
  areaM2: 30,
  climateId: null,
  buildingId: null,
  usageId: null,
  glazingLayers: "double",
  lowE: false,
  argon: false,
  econPrice: DEFAULT_CONFIG.econ.price,
  climateOverrides: {},
  hvacOverrides: {},
  customWallU: null,
  customRoofU: null,
});

export default function FenestraCalculator() {
  const [screen, setScreen] = useState("landing");
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [state, setState] = useState(initialWizardState());

  const restart = () => { setState(initialWizardState()); setScreen("landing"); };

  return (
    <div className="fen-root min-h-screen w-full px-4 py-8 sm:py-10">
      <GlobalStyle />
      <div className="max-w-5xl mx-auto">
        <Nav screen={screen} setScreen={setScreen} />
        {screen === "landing" && <Landing config={config} onStart={() => setScreen("wizard")} setScreen={setScreen} />}
        {screen === "wizard" && <QuickEstimateWizard config={config} state={state} setState={setState} onCalculate={() => setScreen("results")} />}
        {screen === "results" && <ResultsScreen config={config} state={state} setState={setState} onRestart={restart} />}
        {screen === "methodology" && <Methodology setScreen={setScreen} />}
        {screen === "admin" && <AdminGate config={config} setConfig={setConfig} setScreen={setScreen} />}

        <div className="text-center mt-16 pt-6 border-t fen-hairline">
          <button onClick={() => setScreen("admin")} className="text-xs" style={{ color: S.line }}>staff</button>
        </div>
      </div>
    </div>
  );
}
