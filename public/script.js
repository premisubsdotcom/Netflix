function copyText(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.select?.();
  el.setSelectionRange?.(0, 99999);
  navigator.clipboard?.writeText(el.value || el.textContent || '').catch(() => {});
}

function downloadQR(id = 'qrImage') {
  const img = document.getElementById(id);
  if (!img) return;
  const link = document.createElement('a');
  link.href = img.src;
  link.download = `${id}.png`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function togglePanel(id) {
  const panel = document.getElementById(id);
  if (!panel) return;
  const isOpen = panel.classList.contains('show-panel');
  document.querySelectorAll('.hidden-panel').forEach(el => el.classList.remove('show-panel'));
  if (!isOpen) {
    panel.classList.add('show-panel');
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}
