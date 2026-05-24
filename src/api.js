export async function expandWord(word) {
  const res = await fetch('/api/expand', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ word }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error || `Request failed (${res.status})`);
  }

  const data = await res.json();
  if (!Array.isArray(data.pairs) || data.pairs.length === 0) {
    throw new Error('API returned empty result');
  }

  return data.pairs;
}
