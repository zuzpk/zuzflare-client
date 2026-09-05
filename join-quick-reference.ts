/**
 * QUICK REFERENCE: Join and Nested Join in @zuzjs/flare-client
 * 
 * This file shows the exact API signature and query structure.
 */

import { FlareClient } from './src/index';
import { JoinClause, NestedJoinClause } from './src/types';

async function joinExamples() {
    const flare = new FlareClient({
        endpoint: 'http://localhost:5050',
        appId: 'default'
    });

    // ============================================================
    // EXAMPLE 1: Simple Join (One-to-Many)
    // ============================================================
    
    // boards -> lists
    const example1 = await flare.collection('boards')
        .join('lists', {
            source: 'id',        // board.id
            target: 'boardId',   // list.boardId
            as: 'lists'
        })
        .get();

    /* Result:
    [
        {
            id: 'board-1',
            title: 'My Board',
            lists: [                          // Array of joined lists
                { id: 'list-1', title: 'To Do', boardId: 'board-1' },
                { id: 'list-2', title: 'Done', boardId: 'board-1' }
            ]
        }
    ]
    */

    // ============================================================
    // EXAMPLE 2: Nested Join (Three Levels)
    // ============================================================
    
    // boards -> lists -> cards -> comments
    const example2 = await flare.collection('boards')
        // Level 1: Join lists to boards
        .join('lists', {
            source: 'id',
            target: 'boardId',
            as: 'lists'
        })
        // Level 2: Join cards to lists (nested)
        .joinNested('lists', 'cards', {
            source: 'id',
            target: 'listId',
            as: 'cards'
        })
        // Level 3: Join comments to cards (nested)
        .joinNested('cards', 'comments', {
            source: 'id',
            target: 'cardId',
            as: 'comments'
        })
        .get();

    /* Result:
    [
        {
            id: 'board-1',
            title: 'My Board',
            lists: [
                {
                    id: 'list-1',
                    title: 'To Do',
                    cards: [
                        {
                            id: 'card-1',
                            title: 'Task 1',
                            comments: [
                                { id: 'c1', text: 'Great!' },
                                { id: 'c2', text: 'Thanks!' }
                            ]
                        }
                    ]
                }
            ]
        }
    ]
    */

    // ============================================================
    // EXAMPLE 3: Alternative Inline Syntax for Nested Joins
    // ============================================================
    
    const example3 = await flare.collection('boards')
        .join('lists', {
            source: 'id',
            target: 'boardId',
            as: 'lists',
            // Nested join defined inline
            joins: [{
                collection: 'cards',
                source: 'id',
                target: 'listId',
                as: 'cards',
                joins: [{
                    collection: 'comments',
                    source: 'id',
                    target: 'cardId',
                    as: 'comments'
                }]
            }]
        })
        .get();

    // ============================================================
    // EXAMPLE 4: Join with Filters and Options
    // ============================================================
    
    const example4 = await flare.collection('boards')
        .where({ createdBy: 'alice' })
        .join('lists', {
            source: 'id',
            target: 'boardId',
            as: 'lists',
            // Filter on joined collection
            where: [
                { field: 'order', op: '<=', value: 3 }
            ],
            // Sort, limit, select on joined collection
            orderBy: [{ field: 'order', dir: 'asc' }],
            limit: 10,
            select: ['id', 'title', 'order']
        })
        .get();

    // ============================================================
    // EXAMPLE 5: Multiple Independent Joins
    // ============================================================
    
    const example5 = await flare.collection('boards')
        // Join lists
        .join('lists', {
            source: 'id',
            target: 'boardId',
            as: 'lists'
        })
        // Join team members (independent of lists)
        .join('users', {
            source: 'team.uid',   // Nested path
            target: 'id',
            as: 'teamMembers'
        })
        // Join creator (single object)
        .join('users', {
            source: 'createdBy',
            target: 'id',
            as: 'creator',
            single: true
        })
        .get();

    /* Result:
    [
        {
            id: 'board-1',
            lists: [...],
            teamMembers: [...],
            creator: { id: 'alice', name: 'Alice' }  // Object, not array
        }
    ]
    */

    // ============================================================
    // EXAMPLE 6: Aggregation on Joins
    // ============================================================
    
    const example6 = await flare.collection('boards')
        .join('cards', {
            source: 'id',
            target: 'boardId',
            as: 'stats',
            // Count cards per board
            aggregate: [
                { fn: 'count', alias: 'totalCards' },
                { fn: 'sum', field: 'points', alias: 'totalPoints' }
            ],
            groupBy: { fields: ['boardId'] }
        })
        .get();

    /* Result:
    [
        {
            id: 'board-1',
            stats: [
                { boardId: 'board-1', totalCards: 10, totalPoints: 45 }
            ]
        }
    ]
    */

    // ============================================================
    // EXAMPLE 7: SQL-like Relation Shorthand
    // ============================================================
    
    const example7 = await flare.collection('boards')
        // Shorthand: sourceField->targetCollection.targetField
        .withRelation('team.uid->users.id', {
            as: 'teamLead',
            limit: 1,
            select: ['id', 'name', 'email']
        })
        .get();

    // Inline alias syntax
    const example7b = await flare.collection('boards')
        .withRelation('team.uid->users.id as teamLead')
        .get();

    // ============================================================
    // EXAMPLE 8: Realtime Joins with Streams
    // ============================================================
    
    const stream = flare.collection('boards')
        .join('lists', {
            source: 'id',
            target: 'boardId',
            as: 'lists'
        })
        .joinNested('lists', 'cards', {
            source: 'id',
            target: 'listId',
            as: 'cards'
        })
        .stream({
            flushMs: 20,
            maxBatchSize: 100
        });

    const unsubscribe = stream.subscribe((rows, meta) => {
        console.log('Updated boards:', rows);
        console.log('Meta:', meta);
    });

    // Cleanup
    stream.close();
}

/**
 * TYPE DEFINITIONS (for reference)
 * 
 * interface JoinClause {
 *     source?: string;              // Field from base collection (default: 'id')
 *     target: string;              // Field from joined collection
 *     as: string;                  // Alias for joined data
 *     single?: boolean;            // Return object instead of array
 *     where?: AnyFilter[];         // Filters on joined collection
 *     orderBy?: OrderByClause[];   // Sort joined data
 *     limit?: number;               // Limit joined results
 *     offset?: number;              // Offset joined results
 *     select?: string[];            // Select specific fields
 *     aggregate?: AggregateSpec[];  // Aggregation functions
 *     groupBy?: GroupByClause;      // Group by fields
 *     having?: HavingClause[];      // Having filters
 *     joins?: NestedJoinClause[];   // Nested joins
 * }
 * 
 * interface NestedJoinClause extends JoinClause {
 *     collection: string;           // Collection name (required for nested)
 *     source: string;               // Field from parent join (required)
 *     target: string;               // Field from this collection (required)
 *     as: string;                   // Alias (required)
 * }
 */

export { joinExamples };
