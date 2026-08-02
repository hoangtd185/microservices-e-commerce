export interface SeedProduct {
  sku: string;
  name: string;
  price: number;
  stock: number;
}

/**
 * Deliberately scarce SKUs. These are what you point a load test at - the whole
 * question of optimistic vs pessimistic vs atomic locking only becomes visible
 * when many requests converge on one row.
 */
const SCARCE: SeedProduct[] = [
  { sku: 'LIMITED-01', name: 'Limited Drop Sneakers', price: 59.0, stock: 2 },
  { sku: 'FLASH-001', name: 'Flash Sale Power Bank', price: 15.0, stock: 1 },
  { sku: 'FLASH-002', name: 'Flash Sale Earbuds', price: 25.0, stock: 5 },
  { sku: 'FLASH-003', name: 'Flash Sale Rice Cooker', price: 45.0, stock: 10 },
  { sku: 'FLASH-004', name: 'Flash Sale Mechanical Keyboard', price: 39.0, stock: 20 },
  // The load-test fixture: 100 units, one hot row. Reset it with
  //   npm run seed -- --reset-stock
  { sku: 'FLASH-100', name: 'Flash Sale Load Test Unit', price: 9.99, stock: 100 },
];

const FAMILIES = [
  { code: 'PHONE', noun: 'Smartphone', base: 119, step: 40, count: 12 },
  { code: 'HEADSET', noun: 'Wireless Headset', base: 24.5, step: 12, count: 12 },
  { code: 'CABLE', noun: 'USB-C Cable', base: 3.99, step: 2, count: 10 },
  { code: 'LAPTOP', noun: 'Laptop', base: 449, step: 120, count: 10 },
  { code: 'WATCH', noun: 'Smart Watch', base: 39, step: 25, count: 10 },
  { code: 'SHOE', noun: 'Running Shoes', base: 29, step: 15, count: 10 },
  { code: 'SHIRT', noun: 'Cotton T-Shirt', base: 8.5, step: 3, count: 10 },
  { code: 'KETTLE', noun: 'Electric Kettle', base: 18, step: 7, count: 10 },
  { code: 'LAMP', noun: 'Desk Lamp', base: 12, step: 6, count: 10 },
];

const EDITIONS = [
  'Lite', 'Plus', 'Pro', 'Max', 'Mini', 'SE',
  'Ultra', 'Neo', 'Air', 'Go', 'Classic', 'Edge',
];

/**
 * 100 products, generated deterministically - the same catalog every run, so
 * re-seeding never surprises you and SKUs stay stable across environments.
 */
export function buildCatalog(): SeedProduct[] {
  const generated: SeedProduct[] = [];

  for (const family of FAMILIES) {
    for (let i = 0; i < family.count; i++) {
      generated.push({
        sku: `${family.code}-${String(i + 1).padStart(3, '0')}`,
        name: `${family.noun} ${EDITIONS[i % EDITIONS.length]}`,
        price: Number((family.base + family.step * i).toFixed(2)),
        // Spread but reproducible: 50-499 units.
        stock: 50 + ((i * 37 + family.code.length * 11) % 450),
      });
    }
  }

  return [...SCARCE, ...generated];
}
