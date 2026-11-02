/* AmritaKalakriti storefront interactions (progressive enhancement — every form also works without JS). */
(() => {
  'use strict';
  document.documentElement.classList.add('js');
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ---------- Toast ---------- */
  const toastEl = $('[data-toast]');
  let toastTimer;
  function toast(message, { error = false, link } = {}) {
    if (!toastEl) return;
    toastEl.innerHTML = '';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'icon');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', error ? '#i-alert' : '#i-check');
    icon.appendChild(use);
    const text = document.createElement('span');
    text.textContent = message;
    toastEl.append(icon, text);
    if (link) {
      const a = document.createElement('a');
      a.href = link.href;
      a.textContent = link.label;
      toastEl.appendChild(a);
    }
    toastEl.classList.toggle('is-error', error);
    toastEl.hidden = false;
    requestAnimationFrame(() => toastEl.classList.add('is-visible'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('is-visible');
      setTimeout(() => { toastEl.hidden = true; }, 300);
    }, 4200);
  }

  async function postForm(url, form, extra = {}) {
    const body = new URLSearchParams(new FormData(form));
    Object.entries(extra).forEach(([k, v]) => body.set(k, v));
    const res = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON response */ }
    return { status: res.status, data };
  }

  /* ---------- Header ---------- */
  const header = $('[data-header]');
  if (header) {
    const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  const openNav = () => { document.body.classList.add('nav-open'); $('[data-nav-open]')?.setAttribute('aria-expanded', 'true'); };
  const closeNav = () => { document.body.classList.remove('nav-open'); $('[data-nav-open]')?.setAttribute('aria-expanded', 'false'); };
  $('[data-nav-open]')?.addEventListener('click', openNav);
  $$('[data-nav-close]').forEach((el) => el.addEventListener('click', closeNav));

  const megaToggle = $('[data-mega-toggle]');
  if (megaToggle) {
    const item = megaToggle.closest('.has-mega');
    megaToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !item.classList.contains('is-open');
      item.classList.toggle('is-open', open);
      megaToggle.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', (e) => {
      if (!item.contains(e.target)) { item.classList.remove('is-open'); megaToggle.setAttribute('aria-expanded', 'false'); }
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeNav();
    $('.has-mega.is-open')?.classList.remove('is-open');
  });

  /* ---------- Flash messages: click to dismiss ---------- */
  $$('[data-dismissable]').forEach((el) => el.addEventListener('click', () => el.remove()));

  /* ---------- Shop filters & sorting ---------- */
  const filtersToggle = $('[data-filters-toggle]');
  filtersToggle?.addEventListener('click', () => {
    const panel = $('[data-filters]');
    const open = panel.classList.toggle('is-open');
    filtersToggle.setAttribute('aria-expanded', String(open));
  });
  $$('form[data-autosubmit] select').forEach((sel) => sel.addEventListener('change', () => sel.form.submit()));

  /* ---------- Quantity steppers ---------- */
  $$('[data-qty]').forEach((wrap) => {
    const input = $('input', wrap);
    let submitTimer;
    const changed = () => {
      if (!input.hasAttribute('data-autosubmit-input')) return;
      clearTimeout(submitTimer);
      submitTimer = setTimeout(() => input.form.submit(), 450);
    };
    $$('[data-qty-step]', wrap).forEach((btn) => btn.addEventListener('click', () => {
      const min = Number(input.min) || 1;
      const max = Number(input.max) || 99;
      const next = Math.min(max, Math.max(min, (Number(input.value) || 1) + Number(btn.dataset.qtyStep)));
      if (next !== Number(input.value)) { input.value = next; changed(); }
    }));
    input.addEventListener('change', changed);
  });

  /* ---------- Add to cart (AJAX) ---------- */
  const cartBubble = $('[data-cart-count]');
  $$('form[data-add-to-cart]').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      const submitter = e.submitter;
      if (submitter && (submitter.hasAttribute('data-no-ajax') || submitter.hasAttribute('formaction'))) return;
      e.preventDefault();
      const btn = submitter || $('button[type=submit]', form);
      btn.disabled = true;
      try {
        const { status, data } = await postForm(form.action, form);
        if (data.ok) {
          if (cartBubble) {
            cartBubble.textContent = data.count;
            cartBubble.hidden = false;
            cartBubble.classList.remove('bump'); void cartBubble.offsetWidth; cartBubble.classList.add('bump');
          }
          btn.classList.add('is-added');
          toast(data.message, { link: { href: '/cart', label: 'View cart' } });
          setTimeout(() => btn.classList.remove('is-added'), 1800);
        } else if (status === 403) {
          window.location.reload();
        } else {
          toast(data.error || 'Could not add this artwork.', { error: true });
        }
      } catch {
        form.submit();
      } finally {
        btn.disabled = false;
      }
    });
  });

  /* ---------- Wishlist (AJAX) ---------- */
  async function toggleWish(form, btn) {
    btn.disabled = true;
    try {
      const { status, data } = await postForm('/account/wishlist/toggle', form);
      if (status === 401) {
        window.location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
        return;
      }
      if (data.ok) {
        btn.classList.toggle('is-saved', !!data.saved);
        btn.setAttribute('aria-pressed', String(!!data.saved));
        btn.setAttribute('aria-label', data.saved ? 'Remove from wishlist' : 'Save to wishlist');
        toast(data.saved ? 'Saved to your wishlist.' : 'Removed from your wishlist.', data.saved ? { link: { href: '/account/wishlist', label: 'View' } } : {});
      }
    } catch {
      form.submit();
    } finally {
      btn.disabled = false;
    }
  }
  $$('form[data-wishlist-form]').forEach((form) => form.addEventListener('submit', (e) => {
    e.preventDefault();
    toggleWish(form, $('button', form));
  }));
  $$('[data-wishlist-btn]').forEach((btn) => btn.addEventListener('click', (e) => {
    e.preventDefault();
    toggleWish(btn.form, btn);
  }));

  /* ---------- Confirmations & password reveal ---------- */
  $$('form[data-confirm]').forEach((form) => form.addEventListener('submit', (e) => {
    if (!window.confirm(form.dataset.confirm)) e.preventDefault();
  }));
  $$('[data-password-toggle]').forEach((btn) => btn.addEventListener('click', () => {
    const input = btn.parentElement.querySelector('input');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  }));

  /* ---------- Product gallery & "on your wall" ---------- */
  const gallery = $('[data-gallery]');
  if (gallery) {
    const main = $('[data-main-image]', gallery);
    const wallImg = $('[data-wall-art] img', gallery);
    $$('[data-thumb]', gallery).forEach((btn) => btn.addEventListener('click', () => {
      main.src = btn.dataset.thumb;
      if (wallImg) wallImg.src = btn.dataset.thumb;
      $$('[data-thumb]', gallery).forEach((b) => b.setAttribute('aria-current', String(b === btn)));
      if (!$('[data-view="wall"]', gallery).hidden) layoutWall();
    }));

    const wall = $('[data-view="wall"]', gallery);
    const wallBtn = $('[data-view-btn="wall"]', gallery);
    const dims = (wall?.dataset.dims || '').toLowerCase();
    const nums = (dims.match(/\d+(\.\d+)?/g) || []).map(Number);
    const isRound = dims.includes('diameter');
    const longest = Math.max(0, ...nums);
    const canWall = wall && wallBtn && (nums.length >= 2 || isRound) && longest >= 8;
    if (!canWall) $('.gallery-tabs', gallery)?.remove();

    function layoutWall() {
      const art = $('[data-wall-art]', wall);
      const sofa = $('[data-wall-sofa]', wall);
      const W = wall.clientWidth;
      const H = wall.clientHeight;
      const img = wallImg;
      const aspect = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
      let wIn; let hIn;
      if (isRound) { wIn = hIn = longest; } else if (aspect >= 1) { wIn = longest; hIn = longest / aspect; } else { hIn = longest; wIn = longest * aspect; }
      const SOFA_IN = 84; // a 7 ft sofa
      let ppi = Math.min((0.62 * W) / SOFA_IN, (0.81 * H) / (42.6 + hIn), (0.9 * W) / Math.max(wIn, SOFA_IN));
      const sofaW = SOFA_IN * ppi;
      const sofaH = sofaW * 0.4;
      sofa.style.width = `${sofaW}px`;
      sofa.style.height = `${sofaH}px`;
      art.style.width = `${wIn * ppi}px`;
      art.style.height = `${hIn * ppi}px`;
      art.style.bottom = `${0.14 * H + sofaH + 9 * ppi}px`;
      art.style.borderRadius = isRound ? '50%' : '2px';
      art.style.overflow = 'hidden';
    }

    $$('[data-view-btn]', gallery).forEach((btn) => btn.addEventListener('click', () => {
      const view = btn.dataset.viewBtn;
      $$('[data-view]', gallery).forEach((v) => { v.hidden = v.dataset.view !== view; });
      $$('[data-view-btn]', gallery).forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      if (view === 'wall') {
        if (wallImg.complete) layoutWall(); else wallImg.addEventListener('load', layoutWall, { once: true });
      }
    }));
    window.addEventListener('resize', () => { if (wall && !wall.hidden) layoutWall(); });
  }

  /* ---------- Razorpay checkout ---------- */
  const payBtn = $('[data-razorpay]');
  if (payBtn) {
    const form = $('[data-razorpay-form]');
    const open = () => {
      if (typeof window.Razorpay !== 'function') { toast('Loading the payment window… please try again in a second.', { error: true }); return; }
      const d = payBtn.dataset;
      const rzp = new window.Razorpay({
        key: d.key,
        amount: d.amount,
        currency: 'INR',
        order_id: d.orderId,
        name: d.name,
        description: d.description,
        image: new URL(d.image, location.origin).href,
        prefill: { name: d.prefillName, email: d.prefillEmail, contact: d.prefillContact },
        theme: { color: '#8F6420' },
        handler(resp) {
          form.razorpay_order_id.value = resp.razorpay_order_id;
          form.razorpay_payment_id.value = resp.razorpay_payment_id;
          form.razorpay_signature.value = resp.razorpay_signature;
          payBtn.disabled = true;
          payBtn.textContent = 'Confirming your payment…';
          form.submit();
        },
        modal: { ondismiss() { toast('Payment window closed. Your pieces are still reserved — try again whenever you are ready.'); } },
      });
      rzp.on('payment.failed', (resp) => toast(resp.error?.description || 'Payment failed. Please try again.', { error: true }));
      rzp.open();
    };
    payBtn.addEventListener('click', open);
    // Open the payment window automatically once Razorpay's script has loaded.
    window.addEventListener('load', () => { if (typeof window.Razorpay === 'function') open(); });
  }

  /* ---------- Copy to clipboard (UPI ID on the payment page) ---------- */
  if (navigator.clipboard) {
    $$('[data-copy]').forEach((btn) => {
      btn.hidden = false;
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(btn.dataset.copy)
          .then(() => toast(btn.dataset.copied || 'Copied.'), () => toast('Could not copy — please select the text instead.', { error: true }));
      });
    });
  }

  /* ---------- Reveal on scroll ---------- */
  const reveals = $$('.reveal');
  if ('IntersectionObserver' in window && reveals.length) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) { entry.target.classList.add('is-in'); io.unobserve(entry.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add('is-in'));
  }
})();
