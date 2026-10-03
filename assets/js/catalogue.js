const catalogState = {
  products: [],
  category: 'Tous',
  search: '',
  sort: 'featured',
  loadingMessage: 'Chargement des produits…'
};

function catalogEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function catalogPrice(value) {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(Number(value) || 0);
}

function normalizeProduct(row) {
  return {
    id: row.id,
    name: row.name || row.nom || row.libelle || 'Produit',
    description: row.description || row.description_fr || '',
    price: Number(row.price ?? row.prix ?? 0),
    stock: Number(row.stock ?? row.quantite ?? 0),
    stock_min: Number(row.stock_min ?? 0),
    category: row.category || row.categorie || 'Divers',
    reference: row.reference || row.ref || '',
    image: row.image_url || row.image || row.img || ''
  };
}

function getVisibleProducts() {
  let visible = [...catalogState.products];
  const query = catalogState.search.trim().toLocaleLowerCase('fr-FR');

  if (catalogState.category !== 'Tous') {
    visible = visible.filter((product) => product.category === catalogState.category);
  }

  if (query) {
    visible = visible.filter((product) => [
      product.name,
      product.description,
      product.reference,
      product.category
    ].join(' ').toLocaleLowerCase('fr-FR').includes(query));
  }

  switch (catalogState.sort) {
    case 'price-asc':
      visible.sort((left, right) => left.price - right.price);
      break;
    case 'price-desc':
      visible.sort((left, right) => right.price - left.price);
      break;
    case 'name-asc':
      visible.sort((left, right) => left.name.localeCompare(right.name, 'fr'));
      break;
    case 'name-desc':
      visible.sort((left, right) => right.name.localeCompare(left.name, 'fr'));
      break;
    default:
      visible.sort((left, right) => String(left.id).localeCompare(String(right.id), 'fr', { numeric: true }));
  }

  return visible;
}

function renderCategoryFilters() {
  const container = document.getElementById('categoryFilters');
  if (!container) return;

  const categories = ['Tous', ...new Set(catalogState.products.map((product) => product.category))];
  container.innerHTML = categories.map((category) => `
    <button type="button" class="filter-chip${category === catalogState.category ? ' active' : ''}"
      data-category="${catalogEscape(category)}" aria-pressed="${category === catalogState.category}">
      ${catalogEscape(category)}
    </button>
  `).join('');

  container.querySelectorAll('[data-category]').forEach((button) => {
    button.addEventListener('click', () => {
      catalogState.category = button.dataset.category;
      renderCategoryFilters();
      renderProducts();
    });
  });
}

function renderProducts() {
  const grid = document.getElementById('productGrid');
  if (!grid) return;

  const products = getVisibleProducts();
  if (!products.length) {
    const message = catalogState.products.length
      ? 'Aucun produit ne correspond à votre recherche.'
      : catalogState.loadingMessage;
    grid.innerHTML = `
      <div class="col-12">
        <div class="card h-100"><div class="card-body py-5 text-center text-muted">
          <p class="mb-0">${catalogEscape(message)}</p>
        </div></div>
      </div>
    `;
    return;
  }

  grid.innerHTML = products.map((product) => {
    const id = catalogEscape(product.id);
    const name = catalogEscape(product.name);
    const description = catalogEscape(product.description);
    const category = catalogEscape(product.category);
    const reference = catalogEscape(product.reference);
    const image = catalogEscape(product.image || 'https://placehold.co/640x420/f5f5f5/111111?text=Piece+auto');
    const stock = Math.max(0, product.stock);
    const stockStatus = getProductStockStatus(product);

    return `
      <div class="col">
        <article class="card h-100 product-card">
          <img class="card-img-top" src="${image}" alt="${name}" loading="lazy" />
          <div class="card-body d-flex flex-column product-body">
            <span class="product-tag">${category}</span>
            <h3 class="card-title">${name}</h3>
            ${description ? `<p class="card-text text-muted">${description}</p>` : ''}
            <div class="product-meta">
              ${reference ? `<span>Réf. ${reference}</span>` : '<span></span>'}
              <span>${stock} en stock</span>
            </div>
            <div class="mt-2">
              <span class="badge bg-${stockStatus.type === 'danger' ? 'danger' : stockStatus.type === 'warning' ? 'warning text-dark' : 'success'}">${stockStatus.label}</span>
            </div>
            <div class="product-price mt-auto">
              <div class="price">${catalogPrice(product.price)}</div>
              <button class="btn btn-primary" type="button" data-add-product="${id}" ${stock < 1 ? 'disabled' : ''}>
                ${stock > 0 ? 'Ajouter au panier' : 'Indisponible'}
              </button>
            </div>
          </div>
        </article>
      </div>
    `;
  }).join('');

  grid.querySelectorAll('[data-add-product]').forEach((button) => {
    button.addEventListener('click', () => {
      const product = catalogState.products.find((item) => String(item.id) === button.dataset.addProduct);
      if (!product || typeof window.ajouterProduit !== 'function') return;
      window.ajouterProduit(product.id, product.name, product.price, product.image);
      renderMiniCart();
    });
  });
}

function renderMiniCart() {
  const list = document.getElementById('cartItems');
  if (!list) return;

  const cart = typeof window.getPanier === 'function' ? window.getPanier() : [];
  const count = cart.reduce((sum, item) => sum + Number(item.quantite || item.quantity || 0), 0);
  const subtotal = cart.reduce((sum, item) => sum + Number(item.prix || item.price || 0) * Number(item.quantite || item.quantity || 0), 0);
  const shipping = subtotal > 0 ? 9.9 : 0;

  const countBadge = document.getElementById('cartCountBadge');
  if (countBadge) countBadge.textContent = `${count} article${count > 1 ? 's' : ''}`;

  list.innerHTML = cart.length ? cart.map((item) => `
    <div class="cart-item">
      <img src="${catalogEscape(item.image || 'https://placehold.co/120x120/f5f5f5/111111?text=Produit')}" alt="${catalogEscape(item.nom || item.name)}" />
      <div class="cart-item-details">
        <div class="cart-item-title">${catalogEscape(item.nom || item.name)}</div>
        <div class="cart-item-price">${catalogPrice(item.prix ?? item.price)} / unité</div>
        <div class="qty-controls">
          <button class="qty-btn" type="button" data-cart-action="minus" data-cart-id="${catalogEscape(item.id)}" aria-label="Diminuer la quantité">−</button>
          <span class="qty-value">${Number(item.quantite || item.quantity)}</span>
          <button class="qty-btn" type="button" data-cart-action="plus" data-cart-id="${catalogEscape(item.id)}" aria-label="Augmenter la quantité">+</button>
        </div>
      </div>
      <button class="remove-btn" type="button" data-remove-cart-id="${catalogEscape(item.id)}">Suppr.</button>
    </div>
  `).join('') : '<div class="empty-cart">Votre panier est vide.</div>';

  const subtotalNode = document.getElementById('subtotalValue');
  const shippingNode = document.getElementById('shippingValue');
  const totalNode = document.getElementById('totalValue');
  if (subtotalNode) subtotalNode.textContent = catalogPrice(subtotal);
  if (shippingNode) shippingNode.textContent = catalogPrice(shipping);
  if (totalNode) totalNode.textContent = catalogPrice(subtotal + shipping);

  list.querySelectorAll('[data-cart-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const item = cart.find((entry) => String(entry.id) === button.dataset.cartId);
      if (!item || typeof window.modifierQuantite !== 'function') return;
      const quantity = Number(item.quantite || item.quantity) + (button.dataset.cartAction === 'plus' ? 1 : -1);
      window.modifierQuantite(item.id, quantity);
      renderMiniCart();
    });
  });

  list.querySelectorAll('[data-remove-cart-id]').forEach((button) => {
    button.addEventListener('click', () => {
      window.supprimerProduit?.(button.dataset.removeCartId);
      renderMiniCart();
    });
  });
}

function getProductStockStatus(product) {
  const stock = Number(product.stock ?? 0);
  const stockMin = Number(product.stock_min ?? 0);

  if (stock <= 0) return { label: 'Rupture de stock', type: 'danger' };
  if (stock <= stockMin) return { label: 'Stock faible', type: 'warning' };
  return { label: 'En stock', type: 'success' };
}

async function loadCatalogProducts() {
  const grid = document.getElementById('productGrid');
  if (!grid) return;
  renderProducts();

  if (!window.supabaseClient) {
    catalogState.loadingMessage = 'Connexion à Supabase indisponible. Vérifiez sa configuration.';
    renderProducts();
    return;
  }

  try {
    const { data, error } = await window.supabaseClient
      .from('produits')
      .select('*')
      .order('id', { ascending: true });

    if (error) throw error;

    catalogState.products = (data || []).map(normalizeProduct);
    window.products = catalogState.products;
    catalogState.loadingMessage = catalogState.products.length
      ? ''
      : 'Aucun produit n’est enregistré dans la table produits.';
    renderCategoryFilters();
    renderProducts();
    renderMiniCart();
  } catch (error) {
    console.error('Erreur de chargement du catalogue Supabase:', error);
    catalogState.loadingMessage = `Impossible de charger les produits : ${error.message || 'erreur inconnue'}`;
    renderProducts();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('searchInput')?.addEventListener('input', (event) => {
    catalogState.search = event.target.value;
    renderProducts();
  });

  document.getElementById('sortSelect')?.addEventListener('change', (event) => {
    catalogState.sort = event.target.value;
    renderProducts();
  });

  const year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();

  renderCategoryFilters();
  renderMiniCart();
  loadCatalogProducts();
});
