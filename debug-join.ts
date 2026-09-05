/**
 * Debug script to inspect the query structure
 */

import { CollectionReference } from './src/Query/Collection';
import { FlareClient } from './src/index';

// Mock client for testing
const mockClient = {
    send: async () => {},
    subscribe: () => () => {},
    query: async () => [],
    hasQueryPreset: () => false,
    applyQueryPreset: () => {},
    registerQueryPreset: () => {},
} as any;

// Test the query structure
const Collections = {
    Apps: 'apps',
    AppsConfigs: 'apps_configs',
    Modules: 'modules',
    ModuleFields: 'module_fields'
};

const appId = 'fLPNbTvjFNKpauQ1S-';

console.log('\n🔍 Debugging Join Query Structure\n');

const query = new CollectionReference<any>(mockClient, Collections.Apps)
    .where({ 
        id: appId
    })
    .join(Collections.AppsConfigs, {
        source: `id`,
        target: `appId`,
        as: `conf`
    })
    .join(Collections.Modules, {
        source: `id`,
        target: `appId`,
        as: `mods`
    })
    .joinNested(`mods`, Collections.ModuleFields, {
        source: `id`,
        target: `sectionId`,
        as: `fields`
    });

const rawQuery = query.getRawQuery();

console.log('📋 Generated Query Structure:');
console.log(JSON.stringify(rawQuery, null, 2));

console.log('\n📊 Joins Breakdown:');
rawQuery.query.joins?.forEach((join, i) => {
    console.log(`\n  Join ${i + 1}:`);
    console.log(`    Collection: ${join.from}`);
    console.log(`    Local Field: ${join.localField}`);
    console.log(`    Foreign Field: ${join.foreignField}`);
    console.log(`    Alias: ${join.as}`);
    console.log(`    Single: ${join.single}`);
    
    if (join.joins && join.joins.length > 0) {
        console.log(`    Nested Joins:`);
        join.joins.forEach((nested, ni) => {
            console.log(`      Nested ${ni + 1}:`);
            console.log(`        Collection: ${nested.from}`);
            console.log(`        Local Field: ${nested.localField}`);
            console.log(`        Foreign Field: ${nested.foreignField}`);
            console.log(`        Alias: ${nested.as}`);
        });
    }
});

console.log('\n✅ Expected behavior:');
console.log('  - Mods join should have nested joins array with ModuleFields');
console.log('  - ModuleFields should join on Mods.id == ModuleFields.sectionId');

console.log('\n⚠️  Check if server-side join implementation handles nested joins correctly\n');
