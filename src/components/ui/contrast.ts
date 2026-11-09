// Text colour darkened just enough to read at 4.5:1 on its tint: the hue is
// the status colour, the shade is legible (amber on cream was 2:1).
const hexRgb = (value: string) => {
  const hex = value.trim().replace("#", "");
  const full = hex.length === 3 ? hex.split("").map((part) => part + part).join("") : hex;
  return /^[0-9a-f]{6}$/i.test(full) ? [0, 2, 4].map((index) => parseInt(full.slice(index, index + 2), 16)) : null;
};
const channel = (value: number) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]: number[]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a: number[], b: number[]) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// The WCAG contrast ratio of two hex colours, or null when either is not hex.
export function contrastRatio(a: string, b: string) {
  const x = hexRgb(a);
  const y = hexRgb(b);
  return x && y ? contrast(x, y) : null;
}

export function readableOn(color: string, background: string, target = 4.5) {
  let rgb = hexRgb(color);
  const bg = hexRgb(background);
  if (!rgb || !bg) return color;
  for (let step = 0; step < 60 && contrast(rgb, bg) < target; step += 1) rgb = rgb.map((value) => value * 0.95);
  return `#${rgb.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}
