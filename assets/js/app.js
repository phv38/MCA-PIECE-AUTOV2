const STORAGE_KEY = 'mca_cart';

const app = {
  formatCurrency(value) {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(value);
  },
  getProductById(productId) {
    const productList = Array.isArray(window.products) ? window.products : [];
    const targetId = Number(productId);
    return productList.find((product) => Number(product.id) === targetId) || null;
  },
  normalizeCartItem(entry) {
    const normalEntry = {
      id: Number(entry.id),
      quantity: Number(entry.quantity ?? entry.quantite ?? 1),
      name: entry.name || entry.nom || 'Produit',
      price: Number(entry.price ?? entry.prix ?? 0),
      image: entry.image || entry.img || '',
      nom: entry.nom || entry.name || 'Produit',
      prix: Number(entry.prix ?? entry.price ?? 0)
    };

    const product = this.getProductById(normalEntry.id);
    if (product) {
      normalEntry.name = product.name;
      normalEntry.nom = product.name;
      normalEntry.price = Number(product.price);
      normalEntry.prix = Number(product.price);
      normalEntry.image = product.image;
    }

    return normalEntry;
  },
  getCart() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(raw) ? raw.map((entry) => this.normalizeCartItem(entry)) : [];
    } catch {
      return [];
    }
  },
  saveCart(cart) {
    const sanitized = Array.isArray(cart) ? cart.map((entry) => ({
      id: Number(entry.id),
      quantity: Number(entry.quantity ?? entry.quantite ?? 1),
      name: entry.name || entry.nom || 'Produit',
      price: Number(entry.price ?? entry.prix ?? 0),
      image: entry.image || entry.img || '',
      nom: entry.nom || entry.name || 'Produit',
      prix: Number(entry.prix ?? entry.price ?? 0)
    })) : [];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
  },
  addToCart(productId, quantity = 1, productData = null) {
    const cart = this.getCart();
    const product = productData || this.getProductById(productId);
    const item = cart.find((entry) => Number(entry.id) === Number(productId));

    if (item) {
      item.quantity += Number(quantity);
      item.quantite = item.quantity;
    } else {
      cart.push({
        id: Number(productId),
        quantity: Number(quantity),
        quantite: Number(quantity),
        name: product?.name || 'Produit',
        nom: product?.name || 'Produit',
        price: Number(product?.price ?? 0),
        prix: Number(product?.price ?? 0),
        image: product?.image || ''
      });
    }

    this.saveCart(cart);
    return cart;
  },
  updateCart(productId, delta) {
    const cart = this.getCart();
    const item = cart.find((entry) => Number(entry.id) === Number(productId));
    if (!item) return;
    item.quantity += Number(delta);
    item.quantite = item.quantity;
    if (item.quantity <= 0) {
      const filtered = cart.filter((entry) => Number(entry.id) !== Number(productId));
      this.saveCart(filtered);
      return;
    }
    this.saveCart(cart);
  },
  removeFromCart(productId) {
    const cart = this.getCart().filter((entry) => Number(entry.id) !== Number(productId));
    this.saveCart(cart);
  },
  getCartCount() {
    return this.getCart().reduce((sum, item) => sum + Number(item.quantity || item.quantite || 0), 0);
  }
};

document.addEventListener('DOMContentLoaded', () => {
  const yearNode = document.getElementById('year');
  if (yearNode) yearNode.textContent = new Date().getFullYear();
});
window.app = app;
