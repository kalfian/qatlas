// Tokoku demo — progressive enhancement only; every page works server-side too.
'use strict'

// "My account" / "Akun saya" menu button (WAI-ARIA menu button pattern, simplified).
document.addEventListener('click', (event) => {
  const toggle = event.target.closest('.account-toggle')
  const menu = document.getElementById('account-menu')
  if (!menu) return
  if (toggle) {
    const open = toggle.getAttribute('aria-expanded') !== 'true'
    toggle.setAttribute('aria-expanded', String(open))
    menu.hidden = !open
    if (open) menu.querySelector('[role="menuitem"]')?.focus()
  } else if (!event.target.closest('#account-menu')) {
    document.querySelector('.account-toggle')?.setAttribute('aria-expanded', 'false')
    menu.hidden = true
  }
})

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  const menu = document.getElementById('account-menu')
  if (menu && !menu.hidden) {
    menu.hidden = true
    const toggle = document.querySelector('.account-toggle')
    toggle?.setAttribute('aria-expanded', 'false')
    toggle?.focus()
  }
})

// Main navigation hamburger (below 768 px the nav is collapsed behind the "Menu" button).
document.addEventListener('click', (event) => {
  const toggle = event.target.closest('.nav-toggle')
  if (!toggle) return
  const nav = document.getElementById(toggle.getAttribute('aria-controls'))
  const open = toggle.getAttribute('aria-expanded') !== 'true'
  toggle.setAttribute('aria-expanded', String(open))
  nav?.classList.toggle('open', open)
})

// Category filter: navigate as soon as a checkbox changes (?category=a,b / ?kategori=a,b — the
// path and parameter name come from the form, they depend on DEMO_LANG).
const filter = document.querySelector('[data-category-filter]')
if (filter) {
  filter.addEventListener('change', () => {
    const boxes = [...filter.querySelectorAll('input[type="checkbox"]')]
    const chosen = boxes.filter((i) => i.checked).map((i) => i.value)
    const path = filter.getAttribute('action')
    location.href = chosen.length ? `${path}?${boxes[0].name}=${chosen.join(',')}` : path
  })
}

// Cart quantity: save on change (blur / Enter) without reloading the page.
for (const input of document.querySelectorAll('[data-qty-line]')) {
  input.addEventListener('change', async () => {
    const res = await fetch(input.dataset.qtyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ line: Number(input.dataset.qtyLine), qty: Number(input.value) }),
    })
    if (!res.ok) return
    const data = await res.json()
    const row = input.closest('.cart-line')
    row.querySelector('[data-testid="line-total"]').textContent = data.line_total
    document.querySelector('[data-testid="cart-subtotal"]').textContent = data.subtotal
    document.querySelector('[data-testid="cart-count"]').textContent = String(data.count)
  })
}
