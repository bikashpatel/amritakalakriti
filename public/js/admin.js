/* AmritaKalakriti admin — small progressive enhancements. Everything works without JS;
   behaviour is wired through data-* attributes (no inline handlers, CSP-safe). */
(function () {
  'use strict';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const csrf = () => ($('input[name="_csrf"]') || {}).value || '';

  /* ---------------------------------------------------------------- drawer */
  const body = document.body;
  const side = $('#adm-side');
  const opener = $('[data-drawer-open]');
  function setDrawer(open) {
    if (!side) return;
    body.classList.toggle('nav-open', open);
    if (opener) opener.setAttribute('aria-expanded', String(open));
    if (open) {
      const first = side.querySelector('a, button');
      if (first) first.focus();
    } else if (opener && side.contains(document.activeElement)) {
      opener.focus();
    }
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-drawer-open]')) setDrawer(true);
    else if (e.target.closest('[data-drawer-close]')) setDrawer(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && body.classList.contains('nav-open')) setDrawer(false);
  });
  window.matchMedia('(min-width: 961px)').addEventListener('change', (mq) => { if (mq.matches) setDrawer(false); });

  /* ---------------------------------------------------------------- confirmations */
  // data-confirm on a button/link asks on click; on a <form> it asks on submit.
  // data-confirm-if="#select=value" only asks when that control has that value.
  function shouldAsk(el) {
    const cond = el.getAttribute('data-confirm-if');
    if (!cond) return true;
    const [sel, val] = cond.split('=');
    const control = $(sel);
    return Boolean(control && control.value === val);
  }
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-confirm]');
    if (!el || el.tagName === 'FORM') return;
    if (shouldAsk(el) && !window.confirm(el.getAttribute('data-confirm'))) {
      e.preventDefault();
      e.stopImmediatePropagation();
    } else {
      el.dataset.confirmed = '1';
    }
  }, true);
  document.addEventListener('submit', (e) => {
    const form = e.target;
    const submitter = e.submitter;
    if (submitter && submitter.dataset.confirmed) { delete submitter.dataset.confirmed; return; }
    if (form.hasAttribute('data-confirm') && !window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
  });

  /* ---------------------------------------------------------------- filters */
  $$('[data-autosubmit]').forEach((el) => {
    el.addEventListener('change', () => {
      const form = el.form;
      if (!form) return;
      const page = form.querySelector('input[name="page"]');
      if (page) page.remove();
      form.requestSubmit ? form.requestSubmit() : form.submit();
    });
  });

  /* ---------------------------------------------------------------- reveal fields */
  // <select data-reveal="#target" data-reveal-value="shipped"> shows #target only for that value.
  $$('[data-reveal]').forEach((select) => {
    const target = $(select.getAttribute('data-reveal'));
    if (!target) return;
    const want = select.getAttribute('data-reveal-value');
    const sync = () => { target.hidden = select.value !== want; };
    select.addEventListener('change', sync);
    sync();
  });

  /* ---------------------------------------------------------------- slug preview */
  const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  const slugSource = $('[data-slug-source]');
  const slugTarget = $('[data-slug-target]');
  if (slugSource && slugTarget) {
    const fallback = slugTarget.getAttribute('placeholder');
    const sync = () => { slugTarget.placeholder = slugify(slugSource.value) || fallback; };
    slugSource.addEventListener('input', sync);
    sync();
  }

  /* ---------------------------------------------------------------- file previews */
  $$('input[type=file][data-file-preview]').forEach((input) => {
    const out = $(input.getAttribute('data-file-preview'));
    const zone = input.closest('.dropzone');
    let urls = [];
    input.addEventListener('change', () => {
      urls.forEach((u) => URL.revokeObjectURL(u));
      urls = [];
      if (!out) return;
      out.textContent = '';
      Array.from(input.files || []).forEach((file) => {
        const fig = document.createElement('figure');
        if (file.type.startsWith('image/')) {
          const img = document.createElement('img');
          const url = URL.createObjectURL(file);
          urls.push(url);
          img.src = url;
          img.alt = '';
          fig.appendChild(img);
        }
        const cap = document.createElement('figcaption');
        cap.textContent = file.name;
        fig.appendChild(cap);
        out.appendChild(fig);
      });
    });
    if (zone) {
      ['dragenter', 'dragover'].forEach((t) => input.addEventListener(t, () => zone.classList.add('is-over')));
      ['dragleave', 'drop'].forEach((t) => input.addEventListener(t, () => zone.classList.remove('is-over')));
    }
  });

  /* ---------------------------------------------------------------- revenue chart tooltip */
  $$('[data-chart]').forEach((figure) => {
    const tip = figure.querySelector('.chart-tip');
    if (!tip) return;
    const value = tip.querySelector('strong');
    const label = tip.querySelector('span');
    function show(col) {
      value.textContent = col.getAttribute('data-tip-value');
      label.textContent = col.getAttribute('data-tip-label');
      tip.hidden = false;
      const fig = figure.getBoundingClientRect();
      const c = col.getBoundingClientRect();
      const bar = col.querySelector('.bars-bar');
      const barTop = bar && bar.offsetHeight ? bar.getBoundingClientRect().top : c.bottom;
      const half = tip.offsetWidth / 2;
      let x = c.left + c.width / 2 - fig.left;
      x = Math.max(half, Math.min(fig.width - half, x));
      tip.style.left = `${x}px`;
      tip.style.top = `${Math.max(tip.offsetHeight, barTop - fig.top - 10)}px`;
    }
    const hide = () => { tip.hidden = true; };
    figure.querySelectorAll('.bars-col').forEach((col) => {
      col.addEventListener('pointerenter', () => show(col));
      col.addEventListener('focus', () => show(col));
      col.addEventListener('pointerleave', hide);
      col.addEventListener('blur', hide);
    });
  });

  /* ---------------------------------------------------------------- inbox: mark read on open */
  $$('details[data-message]').forEach((details) => {
    details.addEventListener('toggle', () => {
      if (!details.open || !details.hasAttribute('data-unread')) return;
      details.removeAttribute('data-unread');
      fetch(`/admin/messages/${details.getAttribute('data-message')}/read`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrf(), 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
        credentials: 'same-origin',
      }).then((r) => (r.ok ? r.json() : null)).then((data) => {
        if (!data || !data.ok) return;
        details.classList.remove('is-unread');
        const form = details.querySelector('form[action$="/read"]');
        if (form) {
          form.querySelector('input[name="read"]').value = '0';
          const btn = form.querySelector('[data-read-toggle]');
          if (btn) btn.textContent = 'Mark as unread';
        }
        const sr = details.querySelector('summary .sr-only');
        if (sr) sr.remove();
        document.querySelectorAll('.adm-nav-link[href="/admin/messages"] .adm-count').forEach((badge) => {
          if (data.unread > 0) badge.firstChild.textContent = data.unread > 99 ? '99+' : String(data.unread);
          else badge.remove();
        });
      }).catch(() => {});
    });
  });

  /* ---------------------------------------------------------------- missing images */
  // A thumbnail whose file is missing becomes the same placeholder used for "no image".
  function brokenImage(img) {
    if (img.classList.contains('thumb')) {
      const span = document.createElement('span');
      span.className = 'thumb thumb-empty';
      span.title = 'Image file not found';
      span.innerHTML = '<svg class="icon"><use href="#i-image"/></svg>';
      img.replaceWith(span);
    } else {
      img.classList.add('is-broken');
    }
  }
  $$('img.thumb, .img-tile img').forEach((img) => {
    if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) {
      // Either it already failed or it is a lazy image not fetched yet — probe to tell which.
      const probe = new Image();
      probe.addEventListener('error', () => brokenImage(img), { once: true });
      probe.src = img.src;
    } else {
      img.addEventListener('error', () => brokenImage(img), { once: true });
    }
  });

  /* ---------------------------------------------------------------- print */
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-print]')) window.print();
  });
}());
