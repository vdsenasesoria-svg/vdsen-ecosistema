/* VDSEN client export — UI TRIGGER. Confirmation dialog + progress + result for ONE client (the id captured when the dialog opens).
 * DOM is injected (`env.document`) so the controller is testable without a browser. Technical errors never reach the screen. */
(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_CE_UI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  var TEXT = {
    title: 'Exportar cliente',
    message: 'Se generará una copia completa de la información de este cliente. El archivo puede incluir datos sensibles como historial, métricas corporales, notas, recuperación y farmacología.',
    cancel: 'Cancelar', confirm: 'Exportar', running: 'Preparando exportación...',
    success: 'Cliente exportado correctamente', failure: 'La exportación no pudo completarse'
  };

  // env: { document, exporter, download(filename, bytes), toast(msg, isError) }
  function open(req, env) {
    var d = env.document;
    if (env.exporter.busy) { env.toast(TEXT.running, false); return null; }
    var prev = d.getElementById('clientExportDialog'); if (prev && prev.remove) prev.remove();
    var overlay = d.createElement('div'); overlay.id = 'clientExportDialog';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px';
    var box = d.createElement('div'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    box.style.cssText = 'background:#171717;border:1px solid #444;max-width:460px;width:100%;max-height:90vh;overflow:auto;box-sizing:border-box;padding:20px;border-radius:10px;color:#f4f4f0';
    var h = d.createElement('h3'); h.style.cssText = 'margin:0 0 4px;font-size:18px;font-weight:700'; h.textContent = TEXT.title;
    var who = d.createElement('div'); who.style.cssText = 'color:#c8a54a;font-size:13px;margin-bottom:10px;overflow-wrap:anywhere;word-break:break-word'; who.textContent = req.clientName || '';
    var p = d.createElement('p'); p.style.cssText = 'font-size:13px;line-height:1.5;color:#ccc;margin:0 0 14px'; p.textContent = TEXT.message;
    var status = d.createElement('div'); status.style.cssText = 'font-size:13px;min-height:18px;margin-bottom:10px'; status.setAttribute('aria-live', 'polite');
    var row = d.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap';
    var cancel = d.createElement('button'); cancel.type = 'button'; cancel.className = 'btn-secondary'; cancel.textContent = TEXT.cancel;
    var go = d.createElement('button'); go.type = 'button'; go.className = 'btn-primary'; go.textContent = TEXT.confirm;
    row.appendChild(cancel); row.appendChild(go);
    box.appendChild(h); box.appendChild(who); box.appendChild(p); box.appendChild(status); box.appendChild(row); overlay.appendChild(box);
    d.body.appendChild(overlay);
    var running = false;
    function close() { if (!running && overlay.remove) overlay.remove(); }
    cancel.onclick = close;
    go.onclick = async function() {
      if (running) return;
      running = true; go.disabled = true; cancel.disabled = true; status.style.color = '#9ab'; status.textContent = TEXT.running;
      var res;
      try { res = await env.exporter.run({ clientId: req.clientId }); } catch (e) { res = { ok: false, code: 'EXPORT_FAILED', message: TEXT.failure }; }
      running = false;
      if (res && res.ok) {
        try { env.download(res.filename, res.bytes); } catch (e) { res = { ok: false, code: 'EXPORT_FAILED', message: TEXT.failure }; }
      }
      if (res && res.ok) { env.toast(TEXT.success, false); if (overlay.remove) overlay.remove(); return; }
      status.style.color = '#e05555';
      status.textContent = TEXT.failure + (res && res.message && res.message !== TEXT.failure ? '. ' + res.message : '.');
      go.disabled = false; cancel.disabled = false; go.textContent = TEXT.confirm;
      env.toast(TEXT.failure, true);
    };
    return { overlay: overlay, confirmButton: go, cancelButton: cancel, statusEl: status };
  }

  function downloadBytes(doc, win, filename, bytes) {
    var blob = new win.Blob([bytes], { type: 'application/zip' }), url = win.URL.createObjectURL(blob), a = doc.createElement('a');
    a.href = url; a.download = filename; doc.body.appendChild(a); a.click(); doc.body.removeChild(a);
    win.setTimeout(function() { win.URL.revokeObjectURL(url); }, 4000);
  }

  return { TEXT: TEXT, open: open, downloadBytes: downloadBytes };
});
