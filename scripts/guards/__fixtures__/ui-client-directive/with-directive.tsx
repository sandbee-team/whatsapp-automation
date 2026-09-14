'use client';

export function WithDirective() {
  const [open, setOpen] = useState(false);
  return <button onClick={() => setOpen(!open)}>toggle</button>;
}
