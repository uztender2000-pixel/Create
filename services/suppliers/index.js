const ymlFeed = require('./ymlFeed');
const mydrop = require('./mydrop');
const tradeevo = require('./tradeevo');
const hubber = require('./hubber');

// =====================================================================
// Supplier adapter registry.
//
// Every supplier row in the database names an `adapter`. This file maps
// that name to the module that implements it. Adding a new supplier that
// speaks a different protocol (BRAIN, MTI, ASBIS...) means:
//   1. writing services/suppliers/<name>.js against the contract below
//   2. adding one line to ADAPTERS here
//   3. inserting a suppliers row with adapter = '<name>'
// Nothing else in the codebase changes.
//
// ---------------------------------------------------------------------
// ADAPTER CONTRACT
// ---------------------------------------------------------------------
// module.exports = {
//   name: 'brain',
//   capabilities: { catalog, stock, createOrder, orderStatus },  // booleans
//
//   // Pull the whole catalogue, handing normalized products to onBatch in
//   // chunks. Must return the total number of products passed through.
//   async fetchCatalog(supplier, onBatch, options) -> number
//
//   // Optional: refresh only prices and stock, much cheaper than a full
//   // catalogue pull. Same batch shape, but only supplierProductId,
//   // price, stock and available are required per item.
//   async fetchStock(supplier, onBatch, options) -> number
//
//   // Place one order. Every item belongs to this supplier.
//   async createOrder(supplier, order) -> { ok, supplierOrderId?, raw?, reason?, error? }
//
//   // Optional: check an order that was already placed.
//   async getOrderStatus(supplier, supplierOrderId) -> { status, ttn? }
// };
//
// NORMALIZED PRODUCT (what fetchCatalog hands to onBatch):
// {
//   supplierProductId, name, description, price,
//   categoryId, categoryName, section,
//   pictureUrl, pictures[], vendorCode, vendor,
//   params{}, stock, available,
//   meta{}  // optional — anything the supplier's API exposes that has no
//           // dedicated column above (moderation status, "top" flag, the
//           // supplier's own edited-at timestamp, an underlying
//           // sub-supplier's id/name/rating, etc). Stored as-is in
//           // products.raw_meta so the admin product-selection filter
//           // panel can offer it without a schema change. Adapters that
//           // have nothing extra can simply omit this field.
// }
//
// NORMALIZED ORDER (what createOrder receives):
// {
//   groupId, customerName, customerPhone, city, npBranch,
//   deliveryMethod, courierAddress, comment,
//   items: [{ orderId, supplierProductId, quantity, name, retailPrice, costPrice }]
// }
// =====================================================================

const ADAPTERS = {
  yml_feed: ymlFeed,
  mydrop: mydrop,
  tradeevo: tradeevo,
  hubber: hubber,
  // brain: require('./brain'),
  // mti: require('./mti'),
};

function getAdapter(supplier) {
  const adapter = ADAPTERS[supplier.adapter];
  if (!adapter) {
    throw new Error(
      `Невідомий адаптер "${supplier.adapter}" для постачальника "${supplier.name}". ` +
      `Доступні: ${Object.keys(ADAPTERS).join(', ')}`
    );
  }
  return adapter;
}

function listAdapters() {
  return Object.entries(ADAPTERS).map(([key, adapter]) => ({
    key,
    capabilities: adapter.capabilities,
  }));
}

module.exports = { getAdapter, listAdapters, ADAPTERS };
