import * as utils from "./utils";
export class Session {
    constructor(state = {}, schema) {
        this.state = state;
        this.tables = utils.toObject(schema.tables.map(t => new TableModel(this, state[t.name], t)), t => t.schema.name);
    }
    upsert(state, from) {
        Object.keys(state).forEach(name => {
            if (!from || name !== from.schema.name)
                this.tables[name].upsert(state[name]);
        });
    }
    commit() {
        Object.keys(this.tables).forEach(table => {
            const oldState = this.state[table];
            const newState = this.tables[table].state;
            if (oldState !== newState)
                this.state = Object.assign({}, this.state, { [table]: newState });
        });
        return this.state;
    }
}
export class TableModel {
    constructor(session, state = { ids: [], byId: {} }, schema) {
        this.session = session;
        this.state = state;
        this.schema = schema;
    }
    all() {
        return this.state.ids.map(id => ModelFactory.default.newRecordModel(id, this));
    }
    filter(predicate) {
        return this.all().filter(predicate);
    }
    get(id) {
        id = id.toString();
        if (!this.exists(id))
            throw new Error(`No \"${this.schema.name}\" record with id: ${id} exists.`);
        return ModelFactory.default.newRecordModel(id, this);
    }
    getOrDefault(id) {
        return this.exists(id) ? this.get(id) : null;
    }
    exists(id) {
        return this.state.byId[id] !== undefined;
    }
    insert(data) {
        return this.insertMany(data)[0];
    }
    insertMany(data) {
        const norm = this.schema.normalize(data);
        const table = norm[this.schema.name];
        this.state = { ids: this.state.ids.concat(table.ids), byId: Object.assign({}, this.state.byId, table.byId) };
        this.session.upsert(norm, this);
        return table.ids.map(id => ModelFactory.default.newRecordModel(id, this));
    }
    update(data) {
        return this.updateMany(data)[0];
    }
    updateMany(data) {
        const norm = this.schema.normalize(data);
        const table = norm[this.schema.name];
        let state = Object.assign({}, this.state);
        const records = Object.keys(table.byId).map(id => {
            if (!this.state.byId[id])
                throw new Error(`Failed to apply update. No \"${this.schema.name}\" record with id: ${id} exists.`);
            const newRecord = table.byId[id];
            const oldRecord = state.byId[id];
            const modified = this.schema.isModified(oldRecord, newRecord);
            if (modified)
                state.byId[id] = Object.assign({}, oldRecord, newRecord);
            return ModelFactory.default.newRecordModel(id, this);
        });
        this.state = state;
        this.session.upsert(norm, this);
        return records;
    }
    upsert(data) {
        const pk = this.schema.getPrimaryKey(data);
        if (this.exists(pk))
            return this.update(data);
        else
            return this.insert(data);
    }
    delete(id) {
        const byId = Object.assign({}, this.state.byId), ids = this.state.ids.slice();
        delete byId[id];
        const idx = ids.indexOf(id);
        if (idx >= 0)
            ids.splice(idx, 1);
        this.state = Object.assign({}, this.state, { byId: byId, ids: ids });
    }
}
export class RecordModel {
    constructor(id, table) {
        this.id = id;
        this.table = table;
    }
    get value() {
        return this.table.state.byId[this.id];
    }
    delete() {
        this.table.delete(this.id);
    }
    update(data) {
        this.table.update(data);
        return this;
    }
}
export class RecordField {
    constructor(schema, record) {
        this.name = schema.name;
        this.schema = schema;
        this.record = record;
    }
    get value() {
        return this.record.value[this.name];
    }
}
export class RecordSet {
    constructor(records, table, referencedFrom) {
        this.records = records;
        this.table = table;
        this.referencedFrom = referencedFrom;
    }
    map(callback) {
        return this.records.map(callback);
    }
    insert(data) { }
    update(data) { }
}
class ModelFactory {
    constructor() {
        this._recordClass = {};
    }
    newRecordModel(id, table) {
        return new (this._recordClass[table.schema.name] || (this._recordClass[table.schema.name] = this._createRecordModelClass(table.schema)))(id, table);
    }
    newRecordField(schema, record) {
        if (schema.constraint === "FK" && schema.table === record.table.schema && schema.references) {
            const refTable = record.table.session.tables[schema.references];
            if (!refTable)
                throw new Error(`The foreign key ${schema.name} references an unregistered table: ${schema.table.name}`);
            const refId = record.value[schema.name];
            return refTable.getOrDefault(refId);
        }
        else if (schema.constraint === "FK" && schema.table !== record.table.schema && schema.relationName) {
            const refTable = record.table.session.tables[schema.table.name];
            if (!refTable)
                throw new Error(`The foreign key ${schema.name} references an unregistered table: ${schema.table.name}`);
            const refRecords = refTable.filter(r => {
                const refId = r.value[schema.name];
                return refId && refId.toString() === record.id;
            });
            return new RecordSet(refRecords, refTable, new RecordField(schema, record));
        }
        else
            return new RecordField(schema, record);
    }
    _createRecordModelClass(schema) {
        class Record extends RecordModel {
            constructor(id, table) {
                super(id, table);
            }
        }
        schema.fields.forEach(field => {
            if (field.constraint == "FK")
                Object.defineProperty(Record.prototype, field.propName, {
                    get: function () {
                        return ModelFactory.default.newRecordField(field, this);
                    },
                    set: function (value) {
                        return this.update({ [field.name]: value });
                    }
                });
        });
        schema.relations.forEach(field => {
            if (field.relationName)
                Object.defineProperty(Record.prototype, field.relationName, {
                    get: function () {
                        return ModelFactory.default.newRecordField(field, this);
                    },
                    set: function (value) {
                        throw new Error("Invalid attempt to set an foreign table relation field.");
                    }
                });
        });
        return Record;
    }
}
ModelFactory.default = new ModelFactory();
