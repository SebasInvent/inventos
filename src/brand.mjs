// InventOS — identidad de marca central (Invent Agency).
// Una sola fuente de verdad para el look & feel del producto: la usan la CLI, el
// reporte y los defaults de marca de las plantillas. Coherente con el vault de
// Invent (cian eléctrico sobre oscuro, "Development on Demand").

export const BRAND = {
  product: 'InventOS',
  company: 'Invent Agency',
  tagline: 'Development on Demand',
  // Organización por defecto que se ve en los paneles (Supabase Studio, etc.):
  // la firma de marca del instalador se transfiere a cada install.
  org: 'Invent',
  url: 'inventagency.co',
  email: 'hola@inventagency.co',
  // Paleta (para superficies que aceptan color; la CLI usa cian truecolor).
  accent: '#00D4FF', // cian eléctrico
  dark: '#0A0A0A',
};
