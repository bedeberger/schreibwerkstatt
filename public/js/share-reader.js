'use strict';

const form = document.getElementById('share-comment-form');
if (form) {
  const status = document.getElementById('share-comment-status');
  const list = document.querySelector('.share-comments__list');
  const empty = document.querySelector('.share-comments__empty');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.textContent = '';
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    const body = (form.elements['body'].value || '').trim();
    const name = (form.elements['reader_name'].value || '').trim();
    const hp = (form.elements['_hp'].value || '').trim();
    if (!body) { status.textContent = form.dataset.emptyMsg; submit.disabled = false; return; }
    try {
      const res = await fetch(window.location.pathname + '/comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, reader_name: name, _hp: hp }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 429) status.textContent = form.dataset.rateMsg;
        else status.textContent = form.dataset.errorMsg + (j.error_code ? ' (' + j.error_code + ')' : '');
        submit.disabled = false;
        return;
      }
      const li = document.createElement('li');
      li.className = 'share-comments__item';
      const meta = document.createElement('div');
      meta.className = 'share-comments__meta';
      meta.textContent = (j.reader_name || form.dataset.anon) + ' · ' + new Date(j.created_at).toLocaleString();
      const text = document.createElement('div');
      text.className = 'share-comments__body';
      text.textContent = j.body;
      li.appendChild(meta);
      li.appendChild(text);
      if (list) list.insertBefore(li, list.firstChild);
      if (empty) empty.remove();
      form.reset();
      status.textContent = form.dataset.successMsg;
      submit.disabled = false;
    } catch {
      status.textContent = form.dataset.errorMsg;
      submit.disabled = false;
    }
  });
}
