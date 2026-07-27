// Prueba directa del orquestador: dry-run E2E de la receta "agencia".
import { planRecipe } from '../src/engine/index.ts';
import { RECIPES } from '../src/recipes.mjs';

const recipe = RECIPES.find((r) => r.id === 'agencia');
const outcome = await planRecipe(recipe, {
  project: 'demo-cliente',
  domain: 'cliente.com',
  acmeEmail: 'admin@cliente.com',
  adminUser: 'admin',
});

console.log(outcome.plan.summary);
console.log('\n=== VALIDACIÓN DE RENDER ===');
console.log('stacks renderizados:', outcome.rendered);
console.log('tokens sin resolver:', outcome.unresolved.length, outcome.unresolved);
console.log('OK (desplegable):', outcome.ok);
process.exit(outcome.ok ? 0 : 1);
