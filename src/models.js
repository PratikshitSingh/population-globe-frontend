// City size classes used by the "area type" filter. All data and estimates come from the backend.
export const SIZE_CLASSES = [
  { label: 'Megacity', hint: '5M+' },
  { label: 'Large', hint: '1–5M' },
  { label: 'Mid-size', hint: '250k–1M' },
  { label: 'Small', hint: '<250k' },
];
export const sizeClass = (pop) => (pop >= 5e6 ? 0 : pop >= 1e6 ? 1 : pop >= 2.5e5 ? 2 : 3);
