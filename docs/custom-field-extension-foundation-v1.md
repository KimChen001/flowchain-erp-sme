# Custom Field Extension Foundation v1

## Scope

Tenant custom fields extend only the standard Supplier, Item, and Customer
schemas. They do not create custom entities and do not yet control operational
forms, conditional visibility, required rules, or approval workflows.

Stable field paths use:

```text
supplier.custom.<fieldKey>
item.custom.<fieldKey>
customer.custom.<fieldKey>
```

Labels are presentation metadata; mappings and future workflows must reference
the stable `fieldKey`/field path.

## Versioning model

- `CustomFieldDefinition` owns tenant/entity/key identity and lifecycle.
- `CustomFieldRevision` is immutable configuration history.
- `CustomFieldOption` owns stable single-select values and revision labels.
- lifecycle is `draft -> published -> retired`;
- only the published `currentRevisionId` enters new schema resolution;
- publishing a changed configuration requires a new revision;
- a published data type cannot be changed in place;
- retirement is logical, never physical deletion;
- historical intake remains interpretable through its immutable snapshot.

Supported types are `text`, `long_text`, `integer`, `decimal`, `date`,
`boolean`, and `single_select`. Single select requires allowlisted stable option
values. Multi-select, attachment, formula, reference, script, SQL, JavaScript,
and external-API types are not supported.

Keys use lower snake case, are tenant/entity unique, and cannot collide with
canonical fields, prototype keys, or secret-classified keys.

## Permissions and audit

- `custom_field.read`: Intake Uploader, Intake Reviewer, Workspace Administrator
- `custom_field.manage`: Workspace Administrator
- `custom_field.publish`: Workspace Administrator

Create, revision, publication, and retirement write compact audit events.
Audit metadata contains identities, versions, counts, and state changes—not
record bodies, storage paths, secrets, tokens, or raw pasted JSON.

## Intake integration

The tenant schema resolver combines the core canonical schema with current
published custom revisions. A batch captures that result once in
`IntakeSchemaSnapshot`. Later publication or retirement cannot silently change
an in-flight batch. Custom fields appear in a separate mapping group and
normalize into `customFields`.
