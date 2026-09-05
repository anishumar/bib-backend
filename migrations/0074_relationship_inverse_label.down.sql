-- Back to the seeded string from 0002. The value is product data with no
-- foreign keys pointing at it, so this is a plain restore.
UPDATE core.relationship_type
   SET inverse_label = 'a subsidiary of'
 WHERE code = 'parent_of';
