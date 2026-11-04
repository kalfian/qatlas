// Tokoku demo — progressive enhancement only; every page works server-side too.
'use strict'

// "Akun saya" menu button (WAI-ARIA menu button pattern, simplified).
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

// Category filter: navigate as soon as a checkbox changes (?kategori=a,b).
const filter = document.querySelector('[data-category-filter]')
if (filter) {
  filter.addEventListener('change', () => {
    const chosen = [...filter.querySelectorAll('input[name="kategori"]:checked')].map((i) => i.value)
    location.href = chosen.length ? `/kategori?kategori=${chosen.join(',')}` : '/kategori'
  })
}

// Cart quantity: save on change (blur / Enter) without reloading the page.
for (const input of document.querySelectorAll('[data-qty-line]')) {
  input.addEventListener('change', async () => {
    const res = await fetch('/keranjang/ubah', {
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
