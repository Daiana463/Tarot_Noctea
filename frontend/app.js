/* ─── NOCTEA — app.js ─────────────────────────────────────────────────────── */

const API = 'http://localhost:3000/api';

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  currentStep: 1,
  selectedDate: null,
  selectedSlot: null,
  nombre: '',
  email: '',
  telefono: '',
  preferencia: '',
  paymentMethod: null
};

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initCookieBanner();
  initMobileNav();
  initDatePicker();
  initStepNavigation();
  initSlotSelection();
  initContactForm();
  initPaymentMethods();
  initEthicsChecks();
  initFAQ();
  checkURLParams();
  restoreState();
});

// ─── URL params (pago=exito / cancelado) ──────────────────────────────────────
function checkURLParams() {
  const params = new URLSearchParams(window.location.search);
  const pago = params.get('pago');
  if (pago === 'exito') {
    showScreen('success-bizum');
    scrollToBooking();
    clearSavedState();
    cleanURL();
  } else if (pago === 'cancelado') {
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

// ─── LocalStorage persistence ─────────────────────────────────────────────────
function saveState() {
  try {
    localStorage.setItem('noctea_state', JSON.stringify({
      selectedDate: state.selectedDate,
      selectedSlot: state.selectedSlot,
      nombre: state.nombre,
      email: state.email,
      telefono: state.telefono,
      preferencia: state.preferencia
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
    if (saved.nombre) { state.nombre = saved.nombre; setVal('form-nombre', saved.nombre); }
    if (saved.email)  { state.email  = saved.email;  setVal('form-email',  saved.email); }
    if (saved.telefono) { state.telefono = saved.telefono; setVal('form-telefono', saved.telefono); }
    if (saved.preferencia) {
      state.preferencia = saved.preferencia;
      const radio = document.querySelector(`input[name="preferencia"][value="${saved.preferencia}"]`);
      if (radio) radio.checked = true;
    }
  } catch {}
}

function clearSavedState() {
  try { localStorage.removeItem('noctea_state'); } catch {}
}

function setVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}

// ─── Mobile nav ───────────────────────────────────────────────────────────────
function initMobileNav() {
  const toggle = document.getElementById('mobile-toggle');
  const nav    = document.getElementById('mobile-nav');
  if (!toggle || !nav) return;

  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open);
    nav.setAttribute('aria-hidden', !open);
  });

  nav.querySelectorAll('a').forEach(a => {
    a.addEventListener('click', () => {
      nav.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    });
  });
}

// ─── Date picker ──────────────────────────────────────────────────────────────
function initDatePicker() {
  const input = document.getElementById('date-input');
  if (!input) return;

  // Set min date to today
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  input.min = todayStr;

  // Disable weekends via CSS (visual only, enforced in validation)
  input.addEventListener('change', () => {
    const date = input.value;
    const err  = document.getElementById('date-error');
    if (!date) return;

    const d = new Date(date + 'T12:00:00Z');
    const day = d.getUTCDay();

    if (day === 0 || day === 6) {
      showError(err, 'Los fines de semana no hay disponibilidad. Elegí de lunes a viernes.');
      input.value = '';
      state.selectedDate = null;
    } else {
      hideError(err);
      state.selectedDate = date;
      saveState();
    }
  });
}

// ─── Step navigation ──────────────────────────────────────────────────────────
function initStepNavigation() {
  on('btn-step1-next', 'click', goToStep2);
  on('btn-step2-back', 'click', () => goToStep(1));
  on('btn-step2-next', 'click', goToStep3);
  on('btn-step3-back', 'click', () => goToStep(2));
  on('btn-step3-next', 'click', goToStep4);
  on('btn-step4-back', 'click', () => goToStep(3));
  on('btn-error-retry',  'click', () => goToStep(1));
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
  document.querySelectorAll('.booking-step').forEach(el => { el.hidden = true; });
  const el = document.getElementById(id);
  if (el) el.hidden = false;
}

function updateStepNav(active) {
  for (let i = 1; i <= 4; i++) {
    const item = document.getElementById(`nav-step-${i}`);
    if (!item) continue;
    item.classList.remove('active', 'done');
    if (i < active)  item.classList.add('done');
    if (i === active) item.classList.add('active');
  }
}

async function goToStep2() {
  const dateInput = document.getElementById('date-input');
  const err = document.getElementById('date-error');

  if (!state.selectedDate) {
    showError(err, 'Por favor seleccioná una fecha.');
    return;
  }
  const d = new Date(state.selectedDate + 'T12:00:00Z');
  if (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
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

// ─── Availability ─────────────────────────────────────────────────────────────
async function loadAvailability(date) {
  const grid    = document.getElementById('slots-grid');
  const loading = document.getElementById('slots-loading');
  const err     = document.getElementById('slots-error');
  const nextBtn = document.getElementById('btn-step2-next');

  grid.innerHTML = '';
  loading.hidden = false;
  hideError(err);
  nextBtn.disabled = true;

  try {
    const res  = await fetch(`${API}/availability?date=${date}`);
    const data = await res.json();
    loading.hidden = true;

    if (!res.ok) {
      showError(err, data.error || 'No se pudo consultar disponibilidad.');
      return;
    }
    renderSlots(data.slots);
  } catch {
    loading.hidden = true;
    // Fallback: render all as available when backend is not running
    renderSlots(getFallbackSlots());
    showError(err, 'Backend no disponible. Mostrando horarios de ejemplo (configura el servidor para disponibilidad real).');
  }
}

function getFallbackSlots() {
  const slots = [
    '09:00|09:30', '09:45|10:15', '10:30|11:00', '11:15|11:45',
    '14:00|14:30', '14:45|15:15', '15:30|16:00',
    '20:00|20:30', '20:45|21:15', '21:30|22:00'
  ];
  return slots.map(s => {
    const [start, end] = s.split('|');
    return { start, end, label: `${start} a ${end}`, available: true };
  });
}

function renderSlots(slots) {
  const grid = document.getElementById('slots-grid');
  const nextBtn = document.getElementById('btn-step2-next');
  grid.innerHTML = '';

  slots.forEach(slot => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `slot-btn${slot.available ? '' : ' occupied'}`;
    btn.textContent = slot.label;
    btn.disabled = !slot.available;
    if (!slot.available) btn.title = 'No disponible';

    if (slot.available) {
      btn.addEventListener('click', () => {
        grid.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        state.selectedSlot = slot;
        nextBtn.disabled = false;
        hideError(document.getElementById('slots-error'));
      });
    }

    // Restore selection
    if (state.selectedSlot && state.selectedSlot.start === slot.start) {
      btn.classList.add('selected');
      nextBtn.disabled = false;
    }

    grid.appendChild(btn);
  });
}

function renderDateLabel() {
  const el = document.getElementById('display-date');
  if (!el || !state.selectedDate) return;
  const date = new Date(state.selectedDate + 'T12:00:00Z');
  el.textContent = date.toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

// ─── Contact form ─────────────────────────────────────────────────────────────
function initSlotSelection() {} // handled in renderSlots

function initContactForm() {
  ['form-nombre', 'form-email', 'form-telefono'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => {
      const errEl = document.getElementById('error-' + id.replace('form-', ''));
      if (errEl) hideError(errEl);
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
  state.nombre     = getVal('form-nombre').trim();
  state.email      = getVal('form-email').trim();
  state.telefono   = getVal('form-telefono').trim();
  const pref = document.querySelector('input[name="preferencia"]:checked');
  state.preferencia = pref ? pref.value : '';
}

// ─── Summary ──────────────────────────────────────────────────────────────────
function renderSummary() {
  const date = state.selectedDate
    ? new Date(state.selectedDate + 'T12:00:00Z').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : '—';

  setText('sum-fecha',      date);
  setText('sum-horario',    state.selectedSlot?.label || '—');
  setText('sum-nombre',     state.nombre || '—');
  setText('sum-email',      state.email  || '—');
  setText('sum-telefono',   state.telefono || '—');
  setText('sum-preferencia', state.preferencia || '—');

  // Update transfer concept
  setText('transfer-concept', `NOCTEA ${state.nombre} ${state.selectedDate}`);
}

// ─── Payment ──────────────────────────────────────────────────────────────────
function initPaymentMethods() {
  on('btn-pay', 'click', handlePayment);
}

function initEthicsChecks() {
  ['ethics-check-1', 'ethics-check-2', 'legal-check-3'].forEach((id, i) => {
    const el = document.getElementById(id);
    const errId = ['error-check-1', 'error-check-2', 'error-check-3'][i];
    if (el) el.addEventListener('change', () => hideError(document.getElementById(errId)));
  });
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
  btn.disabled = true;
  btn.innerHTML = '<span>Procesando...</span>';

  const body = {
    nombre:               state.nombre,
    email:                state.email,
    telefono:             state.telefono,
    fecha_reserva:        state.selectedDate,
    horario_reserva:      state.selectedSlot?.label,
    preferencia_contacto: state.preferencia
  };

  try {
    const res  = await fetch(`${API}/create-checkout-session`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al crear sesión de pago.');
    if (data.url) window.location.href = data.url;
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true" style="width:16px;height:16px;"><rect x="2" y="5" width="16" height="12" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M2 9h16" stroke="currentColor" stroke-width="1.4"/></svg> Reservar y pagar 22€`;
    showError(document.getElementById('payment-error'), err.message || 'Error inesperado. Por favor intentá de nuevo.');
  }
}

// ─── FAQ Accordion ────────────────────────────────────────────────────────────
function initFAQ() {
  document.querySelectorAll('.faq-question').forEach(btn => {
    btn.addEventListener('click', () => {
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      const answer   = btn.nextElementSibling;

      // Close all
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

// ─── Cookie banner ────────────────────────────────────────────────────────────
function getCookieConsent() {
  return getStorage('noctea_consent_v2');
}

function saveCookieConsent(status) {
  setStorage('noctea_consent_v2', status);
}

function showCookieBanner() {
  const overlay = document.getElementById('cookie-overlay');
  if (!overlay) return;
  overlay.classList.add('is-visible');
  overlay.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function hideCookieBanner() {
  const overlay = document.getElementById('cookie-overlay');
  if (!overlay) return;
  overlay.classList.remove('is-visible');
  overlay.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  // Resetear panel de config por si estaba abierto
  const panel   = document.getElementById('cookie-config-panel');
  const mainAct = document.getElementById('cookie-main-actions');
  const confAct = document.getElementById('cookie-config-actions');
  const text    = document.getElementById('cookie-modal-text');
  if (panel)   panel.hidden   = true;
  if (mainAct) mainAct.hidden = false;
  if (confAct) confAct.hidden = true;
  if (text)    text.hidden    = false;
}

function initCookieBanner() {
  if (getCookieConsent()) return;

  const overlay = document.getElementById('cookie-overlay');
  if (!overlay) return;

  setTimeout(showCookieBanner, 700);

  on('cookie-accept', 'click', () => {
    saveCookieConsent('accepted');
    hideCookieBanner();
  });

  on('cookie-reject', 'click', () => {
    saveCookieConsent('rejected');
    hideCookieBanner();
  });

  on('cookie-config', 'click', () => {
    document.getElementById('cookie-modal-text').hidden  = true;
    document.getElementById('cookie-main-actions').hidden = true;
    document.getElementById('cookie-config-panel').hidden = false;
    document.getElementById('cookie-config-actions').hidden = false;
  });

  on('cookie-back', 'click', () => {
    document.getElementById('cookie-modal-text').hidden  = false;
    document.getElementById('cookie-main-actions').hidden = false;
    document.getElementById('cookie-config-panel').hidden = true;
    document.getElementById('cookie-config-actions').hidden = true;
  });

  on('cookie-save-config', 'click', () => {
    const analytics = document.getElementById('analytics-toggle')?.checked || false;
    saveCookieConsent(analytics ? 'custom-accepted' : 'custom-rejected');
    hideCookieBanner();
  });

  // Cerrar al clic fuera del modal
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      saveCookieConsent('rejected');
      hideCookieBanner();
    }
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function on(id, event, handler) {
  document.getElementById(id)?.addEventListener(event, handler);
}
function getVal(id) { return document.getElementById(id)?.value || ''; }
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
function markInvalid(id) { document.getElementById(id)?.classList.add('invalid'); }
function markValid(id)   { document.getElementById(id)?.classList.remove('invalid'); }
function isValidEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function getStorage(key) { try { return localStorage.getItem(key); } catch { return null; } }
function setStorage(key, val) { try { localStorage.setItem(key, val); } catch {} }

// Botón de footer — resetea consentimiento y muestra el banner de nuevo
function footerResetCookies() {
  try { localStorage.removeItem('noctea_consent_v2'); } catch {}
  showCookieBanner();
}
