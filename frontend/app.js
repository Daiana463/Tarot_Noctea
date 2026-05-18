/* ─── NOCTEA — app.js ─────────────────────────────────────────────────────── */

const API = '/api';

const SLOT_TIMES = [
  ['09:00', '09:30'], ['09:45', '10:15'], ['10:30', '11:00'],
  ['13:15', '13:45'], ['14:00', '14:30'], ['14:45', '15:15'],
  ['15:30', '16:00'], ['20:00', '20:30'], ['20:45', '21:15'],
  ['21:30', '22:00'],
];

const state = {
  currentStep: 1,
  selectedDate: null,
  selectedSlot: null,
  nombre: '',
  email: '',
  telefono: '',
  preferencia: '',
  mensaje: ''
};

document.addEventListener('DOMContentLoaded', () => {
  initCookieBanner();
  initMetaPixel();
  initMobileNav();
  initDatePicker();
  initStepNavigation();
  initSlotSelection();
  initContactForm();
  initPaymentMethods();
  initEthicsChecks();
  initConsentModal();
  initFAQ();
  checkURLParams();
  restoreState();
});

function checkURLParams() {
  const params = new URLSearchParams(window.location.search);
  const pago = params.get('pago');

  if (pago === 'exito') {
    clearSavedState();
    showScreen('success-bizum');
    scrollToBooking();
    cleanURL();
  }

  if (pago === 'cancelado') {
    showScreen('cancel-screen');
    scrollToBooking();
    cleanURL();
  }
}

function cleanURL() {
  window.history.replaceState({}, document.title, window.location.pathname);
}

function scrollToBooking() {
  setTimeout(() => {
    document.getElementById('reserva')?.scrollIntoView({ behavior: 'smooth' });
  }, 300);
}

function saveState() {
  try {
    localStorage.setItem('noctea_state', JSON.stringify({
      selectedDate: state.selectedDate,
      selectedSlot: state.selectedSlot,
      nombre: state.nombre,
      email: state.email,
      telefono: state.telefono,
      preferencia: state.preferencia,
      mensaje: state.mensaje
    }));
  } catch {}
}

function restoreState() {
  try {
    const saved = JSON.parse(localStorage.getItem('noctea_state') || '{}');

    if (saved.selectedDate) {
      state.selectedDate = saved.selectedDate;
      const dateInput = document.getElementById('date-input');
      if (dateInput) dateInput.value = saved.selectedDate;
    }

    if (saved.nombre) {
      state.nombre = saved.nombre;
      setVal('form-nombre', saved.nombre);
    }

    if (saved.email) {
      state.email = saved.email;
      setVal('form-email', saved.email);
    }

    if (saved.telefono) {
      state.telefono = saved.telefono;
      setVal('form-telefono', saved.telefono);
    }

    if (saved.preferencia) {
      state.preferencia = saved.preferencia;
      const radio = document.querySelector(`input[name="preferencia"][value="${saved.preferencia}"]`);
      if (radio) radio.checked = true;
    }

    if (saved.mensaje) {
      state.mensaje = saved.mensaje;
      setVal('form-mensaje', saved.mensaje);
    }
  } catch {}
}

function clearSavedState() {
  try {
    localStorage.removeItem('noctea_state');
  } catch {}
}

function setVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}

function initMobileNav() {
  const toggle = document.getElementById('mobile-toggle');
  const nav = document.getElementById('mobile-nav');
  if (!toggle || !nav) return;

  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    nav.setAttribute('aria-hidden', open ? 'false' : 'true');
  });

  nav.querySelectorAll('a').forEach(a => {
    a.addEventListener('click', () => {
      nav.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      nav.setAttribute('aria-hidden', 'true');
    });
  });
}

function initDatePicker() {
  const input = document.getElementById('date-input');
  if (!input) return;

  const today = new Date();
  input.min = today.toISOString().split('T')[0];

  input.addEventListener('change', () => {
    const date = input.value;
    const err = document.getElementById('date-error');

    if (!date) return;

    const d = new Date(date + 'T12:00:00Z');
    const day = d.getUTCDay();

    state.selectedSlot = null;

    if (day === 0 || day === 6) {
      showError(err, 'Los fines de semana no hay disponibilidad. Elegí de lunes a viernes.');
      input.value = '';
      state.selectedDate = null;
      saveState();
      return;
    }

    hideError(err);
    state.selectedDate = date;
    saveState();
  });
}

function initStepNavigation() {
  on('btn-step1-next', 'click', goToStep2);
  on('btn-step2-back', 'click', () => goToStep(1));
  on('btn-step2-next', 'click', goToStep3);
  on('btn-step3-back', 'click', () => goToStep(2));
  on('btn-step3-next', 'click', goToStep4);
  on('btn-step4-back', 'click', () => goToStep(3));
  on('btn-error-retry', 'click', () => goToStep(1));
  on('btn-cancel-retry', 'click', () => goToStep(4));
}

function goToStep(n) {
  state.currentStep = n;

  document.querySelectorAll('.booking-step').forEach(el => {
    el.hidden = true;
  });

  const step = document.getElementById(`step-${n}`);
  if (step) step.hidden = false;

  updateStepNav(n);
  document.getElementById('reserva')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function showScreen(id) {
  document.querySelectorAll('.booking-step').forEach(el => {
    el.hidden = true;
  });

  const el = document.getElementById(id);
  if (el) el.hidden = false;
}

function updateStepNav(active) {
  for (let i = 1; i <= 4; i++) {
    const item = document.getElementById(`nav-step-${i}`);
    if (!item) continue;

    item.classList.remove('active', 'done');

    if (i < active) item.classList.add('done');
    if (i === active) item.classList.add('active');
  }
}

async function goToStep2() {
  const err = document.getElementById('date-error');

  if (!state.selectedDate) {
    showError(err, 'Por favor seleccioná una fecha.');
    return;
  }

  const d = new Date(state.selectedDate + 'T12:00:00Z');
  const day = d.getUTCDay();

  if (day === 0 || day === 6) {
    showError(err, 'Los fines de semana no tienen disponibilidad.');
    return;
  }

  hideError(err);
  goToStep(2);
  renderDateLabel();
  await loadAvailability(state.selectedDate);
}

function goToStep3() {
  if (!state.selectedSlot) {
    showError(document.getElementById('slots-error'), 'Por favor seleccioná un horario.');
    return;
  }

  hideError(document.getElementById('slots-error'));
  goToStep(3);
}

function goToStep4() {
  if (!validateContactForm()) return;

  collectFormData();
  saveState();
  renderSummary();
  goToStep(4);
}

async function loadAvailability(date) {
  const grid    = document.getElementById('slots-grid');
  const status  = document.getElementById('slots-status');
  const err     = document.getElementById('slots-error');
  const nextBtn = document.getElementById('btn-step2-next');

  if (!grid || !nextBtn) return;

  // Mostrar slots placeholder inmediatamente, sin spinner
  renderPlaceholderSlots();
  if (status) { status.textContent = 'Verificando...'; status.hidden = false; }
  hideError(err);
  nextBtn.disabled  = true;
  state.selectedSlot = null;

  try {
    const res  = await fetch(`${API}/availability?date=${encodeURIComponent(date)}`);
    const data = await res.json();

    if (status) status.hidden = true;

    if (!res.ok) {
      renderSlots([], true);
      showError(err, data.error || 'No se pudo consultar disponibilidad.');
      return;
    }

    renderSlots(data.slots || []);
  } catch {
    if (status) status.hidden = true;
    renderSlots([], true);
    showError(err, 'No se pudo consultar la disponibilidad. Intentá de nuevo.');
  }
}

function renderPlaceholderSlots() {
  const grid = document.getElementById('slots-grid');
  if (!grid) return;
  grid.innerHTML = '';
  SLOT_TIMES.forEach(([start, end]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'slot-btn slot-verifying';
    btn.textContent = `${start} a ${end}`;
    btn.disabled = true;
    grid.appendChild(btn);
  });
}

function renderSlots(slots, isError = false) {
  const grid    = document.getElementById('slots-grid');
  const nextBtn = document.getElementById('btn-step2-next');

  if (!grid || !nextBtn) return;

  grid.innerHTML = '';
  nextBtn.disabled = true;

  // Error de red o API: mostrar todos los slots como "No disponible"
  if (isError) {
    SLOT_TIMES.forEach(([start, end]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'slot-btn slot-error';
      btn.innerHTML = `${start} a ${end}<span class="slot-tag">No disponible</span>`;
      btn.disabled = true;
      grid.appendChild(btn);
    });
    return;
  }

  // Sin horarios en esa fecha (ej. festivo o sin agenda)
  if (!slots.length) {
    grid.innerHTML = '<p class="slots-empty">No hay horarios disponibles para esta fecha. Elegí otro día.</p>';
    return;
  }

  slots.forEach(slot => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `slot-btn${slot.available ? '' : ' occupied'}`;
    btn.disabled = !slot.available;

    if (slot.available) {
      btn.textContent = slot.label;
      btn.addEventListener('click', () => {
        grid.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        state.selectedSlot = slot;
        nextBtn.disabled = false;
        hideError(document.getElementById('slots-error'));
        saveState();
      });
    } else {
      btn.innerHTML = `${slot.label}<span class="slot-tag">Ocupado</span>`;
      btn.title = 'No disponible';
    }

    grid.appendChild(btn);
  });
}

function renderDateLabel() {
  const el = document.getElementById('display-date');
  if (!el || !state.selectedDate) return;

  const date = new Date(state.selectedDate + 'T12:00:00Z');

  el.textContent = date.toLocaleDateString('es-ES', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

function initSlotSelection() {}

function initContactForm() {
  ['form-nombre', 'form-email', 'form-telefono', 'form-mensaje'].forEach(id => {
    const el = document.getElementById(id);

    if (el) {
      el.addEventListener('input', () => {
        const errEl = document.getElementById('error-' + id.replace('form-', ''));
        if (errEl) hideError(errEl);
      });
    }
  });

  document.querySelectorAll('input[name="preferencia"]').forEach(radio => {
    radio.addEventListener('change', () => {
      hideError(document.getElementById('error-preferencia'));
    });
  });
}

function validateContactForm() {
  let valid = true;

  const nombre = getVal('form-nombre').trim();

  if (!nombre) {
    showError(document.getElementById('error-nombre'), 'El nombre completo es obligatorio.');
    markInvalid('form-nombre');
    valid = false;
  } else {
    markValid('form-nombre');
  }

  const email = getVal('form-email').trim();

  if (!email || !isValidEmail(email)) {
    showError(document.getElementById('error-email'), 'Introducí un email válido.');
    markInvalid('form-email');
    valid = false;
  } else {
    markValid('form-email');
  }

  const tel = getVal('form-telefono').trim();

  if (!tel) {
    showError(document.getElementById('error-telefono'), 'El teléfono es obligatorio.');
    markInvalid('form-telefono');
    valid = false;
  } else {
    markValid('form-telefono');
  }

  const pref = document.querySelector('input[name="preferencia"]:checked');

  if (!pref) {
    showError(document.getElementById('error-preferencia'), 'Seleccioná una preferencia de consulta.');
    valid = false;
  } else {
    hideError(document.getElementById('error-preferencia'));
  }

  return valid;
}

function collectFormData() {
  state.nombre    = getVal('form-nombre').trim();
  state.email     = getVal('form-email').trim();
  state.telefono  = getVal('form-telefono').trim();
  state.mensaje   = getVal('form-mensaje').trim();

  const pref = document.querySelector('input[name="preferencia"]:checked');
  state.preferencia = pref ? pref.value : '';
}

function renderSummary() {
  const date = state.selectedDate
    ? new Date(state.selectedDate + 'T12:00:00Z').toLocaleDateString('es-ES', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      })
    : '—';

  setText('sum-fecha', date);
  setText('sum-horario', state.selectedSlot?.label || '—');
  setText('sum-nombre', state.nombre || '—');
  setText('sum-email', state.email || '—');
  setText('sum-telefono', state.telefono || '—');
  setText('sum-preferencia', state.preferencia || '—');
}

function initPaymentMethods() {
  on('btn-pay', 'click', handlePayment);
}

function initEthicsChecks() {
  // Guard para el botón de 32€ en step-4
  function syncNocteaGuard() {
    const c1  = document.getElementById('ethics-check-1');
    const c3  = document.getElementById('legal-check-3');
    const btn = document.getElementById('stripe-btn-noctea');
    if (!btn) return;
    const ok = c1?.checked && c3?.checked;
    btn.style.pointerEvents = ok ? '' : 'none';
    btn.style.opacity       = ok ? '' : '0.45';
  }

  // Guard para el botón de 9€ en card 01
  function syncCard9Guard() {
    const c1  = document.getElementById('card-check-1a');
    const c3  = document.getElementById('card-check-3a');
    const btn = document.getElementById('stripe-btn-9eur');
    if (!btn) return;
    const ok = c1?.checked && c3?.checked;
    btn.style.pointerEvents = ok ? '' : 'none';
    btn.style.opacity       = ok ? '' : '0.45';
  }

  // Guard para el botón de 15€ en card 02
  function syncCard15Guard() {
    const c1  = document.getElementById('card-check-1b');
    const c3  = document.getElementById('card-check-3b');
    const btn = document.getElementById('stripe-btn-15eur');
    if (!btn) return;
    const ok = c1?.checked && c3?.checked;
    btn.style.pointerEvents = ok ? '' : 'none';
    btn.style.opacity       = ok ? '' : '0.45';
  }

  // Listeners step-4 (32€)
  ['ethics-check-1', 'ethics-check-2', 'legal-check-3'].forEach((id, i) => {
    const el    = document.getElementById(id);
    const errId = ['error-check-1', 'error-check-2', 'error-check-3'][i];
    if (el) {
      el.addEventListener('change', () => {
        hideError(document.getElementById(errId));
        syncNocteaGuard();
      });
    }
  });

  // Listeners card 9€
  ['card-check-1a', 'card-check-3a'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', syncCard9Guard);
  });

  // Listeners card 15€
  ['card-check-1b', 'card-check-3b'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', syncCard15Guard);
  });

  syncNocteaGuard();
  syncCard9Guard();
  syncCard15Guard();
}

async function handlePayment() {
  const check1 = document.getElementById('ethics-check-1');
  const check2 = document.getElementById('ethics-check-2');
  const check3 = document.getElementById('legal-check-3');

  let valid = true;

  if (!check1?.checked) {
    showError(document.getElementById('error-check-1'), 'Para continuar debés aceptar el código ético.');
    valid = false;
  }

  if (!check2?.checked) {
    showError(document.getElementById('error-check-2'), 'Debés aceptar los límites éticos para continuar.');
    valid = false;
  }

  if (!check3?.checked) {
    showError(document.getElementById('error-check-3'), 'Debés aceptar la Política de Privacidad y las Condiciones de Contratación para continuar.');
    valid = false;
  }

  if (!valid) return;

  hideError(document.getElementById('payment-error'));

  const btn = document.getElementById('btn-pay');
  if (!btn) return;

  const btnOriginal = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span>Redirigiendo a pago seguro...</span>';

  try {
    const res = await fetch(`${API}/create-checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nombre:         state.nombre,
        email:          state.email,
        telefono:       state.telefono,
        mensaje:        state.mensaje,
        fecha_reserva:  state.selectedDate,
        horario_inicio: state.selectedSlot?.start,
        horario_fin:    state.selectedSlot?.end,
        horario_label:  state.selectedSlot?.label,
        preferencia:    state.preferencia
      })
    });

    const data = await res.json();

    if (!res.ok || !data.url) {
      throw new Error(data.error || 'No se pudo iniciar el pago. Intentá de nuevo.');
    }

    window.location.href = data.url;

  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = btnOriginal;
    showError(
      document.getElementById('payment-error'),
      err.message || 'Error inesperado. Por favor intentá de nuevo.'
    );
  }
}

function initFAQ() {
  document.querySelectorAll('.faq-question').forEach(btn => {
    btn.addEventListener('click', () => {
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      const answer = btn.nextElementSibling;

      document.querySelectorAll('.faq-question').forEach(b => {
        b.setAttribute('aria-expanded', 'false');
        const a = b.nextElementSibling;
        if (a) a.hidden = true;
      });

      if (!expanded) {
        btn.setAttribute('aria-expanded', 'true');
        if (answer) answer.hidden = false;
      }
    });
  });
}

function getCookieConsent() {
  return getStorage('noctea_consent_v2');
}

function saveCookieConsent(status) {
  setStorage('noctea_consent_v2', status);
}

function showCookieBanner() {
  const banner = document.getElementById('cookie-banner');
  if (!banner) return;

  banner.hidden = false;
  banner.classList.add('is-visible');
}

function hideCookieBanner() {
  const banner = document.getElementById('cookie-banner');
  const panel = document.getElementById('cookie-config-panel');

  if (banner) {
    banner.classList.remove('is-visible');
    banner.hidden = true;
  }

  if (panel) {
    panel.hidden = true;
  }
}

function initCookieBanner() {
  if (getCookieConsent()) return;

  const banner = document.getElementById('cookie-banner');
  const panel = document.getElementById('cookie-config-panel');

  if (!banner) return;

  setTimeout(showCookieBanner, 700);

  on('cookie-accept', 'click', () => {
    saveCookieConsent('accepted');
    hideCookieBanner();
    grantAnalytics(true);
  });

  on('cookie-reject', 'click', () => {
    saveCookieConsent('rejected');
    hideCookieBanner();
    grantAnalytics(false);
  });

  on('cookie-config', 'click', () => {
    if (panel) panel.hidden = false;
  });

  on('cookie-save-config', 'click', () => {
    const analytics = document.getElementById('analytics-toggle')?.checked || false;
    saveCookieConsent(analytics ? 'custom-accepted' : 'custom-rejected');
    hideCookieBanner();
    grantAnalytics(analytics);
  });
}

function grantAnalytics(granted) {
  try {
    if (typeof gtag === 'function') {
      const state = granted ? 'granted' : 'denied';
      gtag('consent', 'update', {
        analytics_storage:  state,
        ad_storage:         state,
        ad_user_data:       state,
        ad_personalization: state,
      });
    }
  } catch(e) {}
  if (granted) loadMetaPixel();
}

function loadMetaPixel() {
  if (window._nocteaPixelLoaded) return;
  window._nocteaPixelLoaded = true;
  (function(f,b,e,v,n,t,s){
    if(f.fbq)return;
    n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};
    if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
    n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t,s);
  })(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
  fbq('init','1669616460740520');
  fbq('track','PageView');
}

function initMetaPixel() {
  var consent = getCookieConsent();
  if (consent === 'accepted' || consent === 'custom-accepted') {
    loadMetaPixel();
  }
}

function footerResetCookies() {
  try {
    localStorage.removeItem('noctea_consent_v2');
  } catch {}

  showCookieBanner();
}

function on(id, event, handler) {
  document.getElementById(id)?.addEventListener(event, handler);
}

function getVal(id) {
  return document.getElementById(id)?.value || '';
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function showError(el, msg) {
  if (!el) return;

  el.textContent = msg;
  el.hidden = false;
}

function hideError(el) {
  if (!el) return;

  el.hidden = true;
  el.textContent = '';
}

function markInvalid(id) {
  document.getElementById(id)?.classList.add('invalid');
}

function markValid(id) {
  document.getElementById(id)?.classList.remove('invalid');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setStorage(key, val) {
  try {
    localStorage.setItem(key, val);
  } catch {}
}

// ── Modal de consentimiento para consultas 9€ y 15€ ──────────────────────────

function initConsentModal() {
  const modal  = document.getElementById('consent-modal');
  if (!modal) return;

  const check1  = document.getElementById('modal-check-1');
  const check3  = document.getElementById('modal-check-3');
  const wrap9   = document.getElementById('modal-stripe-9');
  const wrap15  = document.getElementById('modal-stripe-15');

  function syncGuard() {
    const ok = check1?.checked && check3?.checked;
    ['stripe-btn-9eur', 'stripe-btn-15eur'].forEach(id => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.style.pointerEvents = ok ? '' : 'none';
      btn.style.opacity       = ok ? '1' : '0.35';
    });
  }

  check1?.addEventListener('change', syncGuard);
  check3?.addEventListener('change', syncGuard);

  document.querySelectorAll('[data-open-consent]').forEach(trigger => {
    trigger.addEventListener('click', () => {
      const product = trigger.dataset.openConsent;
      if (check1) check1.checked = false;
      if (check3) check3.checked = false;
      if (wrap9)  wrap9.hidden  = (product !== '9');
      if (wrap15) wrap15.hidden = (product !== '15');
      syncGuard();
      modal.showModal();
    });
  });

  document.getElementById('consent-modal-close')
    ?.addEventListener('click', () => modal.close());

  modal.addEventListener('click', e => {
    if (e.target === modal) modal.close();
  });
}
