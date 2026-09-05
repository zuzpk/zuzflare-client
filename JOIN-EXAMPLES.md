# @zuzjs/flare-client Join Examples

This document demonstrates how to use join and nested join operations in the Flare client.

## Basic Join

Join two collections where a field in the source collection matches a field in the target collection.

```typescript
// Join boards with their lists
const boardsWithLists = await flare.collection('boards')
    .join('lists', {
        source: 'id',        // board.id
        target: 'boardId',   // list.boardId
        as: 'lists'          // alias for joined data
    })
    .get();

// Result structure:
// [
//   {
//     id: 'board-1',
//     title: 'Project Alpha',
//     lists: [
//       { id: 'list-1', title: 'To Do', boardId: 'board-1' },
//       { id: 'list-2', title: 'In Progress', boardId: 'board-1' }
//     ]
//   }
// ]
```

## Multiple Joins

Join multiple collections in a single query.

```typescript
const boardsWithListsAndMembers = await flare.collection('boards')
    .join('lists', {
        source: 'id',
        target: 'boardId',
        as: 'lists'
    })
    .join('users', {
        source: 'team.uid',   // nested path in board document
        target: 'id',         // user.id
        as: 'teamMembers'
    })
    .get();
```

## Nested Joins

Create hierarchical joins where each level builds on the previous join.

```typescript
const boardWithNestedData = await flare.collection('boards')
    // First join: boards -> lists
    .join('lists', {
        source: 'id',
        target: 'boardId',
        as: 'lists'
    })
    // Nested join: lists -> cards (under 'lists' alias)
    .joinNested('lists', 'cards', {
        source: 'id',
        target: 'listId',
        as: 'cards'
    })
    // Nested join: cards -> comments (under 'cards' alias)
    .joinNested('cards', 'comments', {
        source: 'id',
        target: 'cardId',
        as: 'comments'
    })
    .get();

// Result structure:
// [
//   {
//     id: 'board-1',
//     lists: [
//       {
//         id: 'list-1',
//         cards: [
//           {
//             id: 'card-1',
//             comments: [
//               { id: 'comment-1', text: 'Looks good!' }
//             ]
//           }
//         ]
//       }
//     ]
//   }
// ]
```

## Alternative: Inline Nested Joins

You can also define nested joins inline in a single `.join()` call:

```typescript
const boardWithNestedData = await flare.collection('boards')
    .join('lists', {
        source: 'id',
        target: 'boardId',
        as: 'lists',
        joins: [{
            collection: 'cards',
            source: 'id',
            target: 'listId',
            as: 'cards',
            joins: [{
                collection: 'comments',
                source: 'id',
                target: 'cardId',
                as: 'comments',
                limit: 5
            }]
        }]
    })
    .get();
```

## SQL-like Relation Shorthand

Use `.withRelation()` for a more concise syntax similar to SQL joins.

```typescript
// Basic syntax: "sourceField->targetCollection.targetField"
const boardsWithMembers = await flare.collection('boards')
    .withRelation('team.uid->users.id', {
        as: 'teamMembers',
        limit: 10
    })
    .get();

// Inline alias syntax
const boardsWithMembers = await flare.collection('boards')
    .withRelation('team.uid->users.id as teamMembers')
    .get();
```

## Join Options

All join methods support additional query options:

```typescript
const boardsWithFilteredLists = await flare.collection('boards')
    .join('lists', {
        source: 'id',
        target: 'boardId',
        as: 'lists',
        
        // Filter joined data
        where: [
            { field: 'order', op: '<=', value: 3 }
        ],
        
        // Sort joined data
        orderBy: [
            { field: 'order', dir: 'asc' }
        ],
        
        // Limit joined results
        limit: 10,
        offset: 0,
        
        // Select specific fields
        select: ['id', 'title', 'order'],
        
        // Aggregate joined data
        aggregate: [
            { fn: 'count', alias: 'totalCards' }
        ],
        groupBy: { fields: ['boardId'] }
    })
    .get();
```

## Single-Object Join (One-to-One)

Use `single: true` to get an object instead of an array for one-to-one relationships.

```typescript
const boardsWithCreator = await flare.collection('boards')
    .join('users', {
        source: 'createdBy',
        target: 'id',
        as: 'creator',
        single: true  // Returns object, not array
    })
    .get();

// Result structure:
// [
//   {
//     id: 'board-1',
//     title: 'Project Alpha',
//     creator: { id: 'alice', name: 'Alice Johnson' }  // Object, not array
//   }
// ]
```

## Complete Example: Task Board Dashboard

```typescript
const dashboardData = await flare.collection('boards')
    .where({ createdBy: 'alice' })
    .latest()
    .limit(10)
    // Join lists with nested cards and comments
    .join('lists', {
        source: 'id',
        target: 'boardId',
        as: 'lists',
        orderBy: [{ field: 'order', dir: 'asc' }],
        joins: [{
            collection: 'cards',
            source: 'id',
            target: 'listId',
            as: 'cards',
            joins: [{
                collection: 'comments',
                source: 'id',
                target: 'cardId',
                as: 'comments',
                limit: 5
            }]
        }]
    })
    // Join creator (single object)
    .join('users', {
        source: 'createdBy',
        target: 'id',
        as: 'creator',
        single: true,
        select: ['id', 'name', 'email']
    })
    .get();
```

## Join API Reference

### `.join(collection, options)`

Joins another collection to the query.

**Parameters:**
- `collection` (string): The collection name to join
- `options` (JoinClause):
  - `source` (string): Field from the base collection (defaults to 'id')
  - `target` (string): Field from the joined collection
  - `as` (string): Alias for the joined data
  - `single` (boolean): Return object instead of array
  - `where`, `orderBy`, `limit`, `offset`: Standard query options
  - `aggregate`, `groupBy`, `having`: Aggregation options
  - `joins`: Nested joins (array of NestedJoinClause)

### `.joinNested(parentAlias, collection, options)`

Appends a nested join under an existing join alias.

**Parameters:**
- `parentAlias` (string): The alias of the parent join
- `collection` (string): The collection name to join
- `options` (JoinClause): Same as `.join()` options

### `.withRelation(relation, options?)`

SQL-like relation shorthand.

**Parameters:**
- `relation` (string): Format: `"sourceField->targetCollection.targetField"` or `"sourceField->targetCollection.targetField as alias"`
- `options` (object): Additional join options (excluding source, target, as)

## Notes

1. **Field Paths**: Both `source` and `target` support nested field paths (e.g., `'team.uid'`)
2. **Nested Joins**: You can chain multiple levels of nested joins
3. **Performance**: Use `limit`, `select`, and filters on joins to optimize performance
4. **Realtime**: Joins work with `.onSnapshot()` and `.stream()` for realtime updates
5. **Server-Side**: All join operations are executed server-side for optimal performance
