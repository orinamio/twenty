import { Injectable } from '@nestjs/common';

import { QueryRunner, TableColumn } from 'typeorm';
import { v4 } from 'uuid';

import {
  WorkspaceMigrationColumnAlter,
  WorkspaceMigrationRenamedEnum,
} from 'src/engine/metadata-modules/workspace-migration/workspace-migration.entity';
import { serializeDefaultValue } from 'src/engine/metadata-modules/field-metadata/utils/serialize-default-value';

@Injectable()
export class WorkspaceMigrationEnumService {
  async alterEnum(
    queryRunner: QueryRunner,
    schemaName: string,
    tableName: string,
    migrationColumn: WorkspaceMigrationColumnAlter,
  ) {
    // Rename column name
    if (
      migrationColumn.currentColumnDefinition.columnName !==
      migrationColumn.alteredColumnDefinition.columnName
    ) {
      await this.renameColumn(
        queryRunner,
        schemaName,
        tableName,
        migrationColumn.currentColumnDefinition.columnName,
        migrationColumn.alteredColumnDefinition.columnName,
      );
    }

    const columnDefinition = migrationColumn.alteredColumnDefinition;
    const oldEnumTypeName = `${tableName}_${migrationColumn.currentColumnDefinition.columnName}_enum`;
    const tempEnumTypeName = `${oldEnumTypeName}_temp`;
    const newEnumTypeName = `${tableName}_${columnDefinition.columnName}_enum`;
    const enumValues =
      columnDefinition.enum?.map((enumValue) => {
        if (typeof enumValue === 'string') {
          return enumValue;
        }

        return enumValue.to;
      }) ?? [];
    const renamedEnumValues = columnDefinition.enum?.filter(
      (enumValue): enumValue is WorkspaceMigrationRenamedEnum =>
        typeof enumValue !== 'string',
    );

    if (!columnDefinition.isNullable && !columnDefinition.defaultValue) {
      columnDefinition.defaultValue = serializeDefaultValue(enumValues[0]);
    }

    const oldColumnName = `${columnDefinition.columnName}_old_${v4()}`;

    // Rename old column
    await this.renameColumn(
      queryRunner,
      schemaName,
      tableName,
      columnDefinition.columnName,
      oldColumnName,
    );
    await this.renameEnumType(
      queryRunner,
      schemaName,
      oldEnumTypeName,
      tempEnumTypeName,
    );

    await queryRunner.addColumn(
      `${schemaName}.${tableName}`,
      new TableColumn({
        name: columnDefinition.columnName,
        type: columnDefinition.columnType,
        default: columnDefinition.defaultValue,
        enum: enumValues,
        enumName: newEnumTypeName,
        isArray: columnDefinition.isArray,
        isNullable: columnDefinition.isNullable,
      }),
    );

    await this.migrateEnumValues(
      queryRunner,
      schemaName,
      migrationColumn,
      tableName,
      oldColumnName,
      enumValues,
      renamedEnumValues,
    );

    // Drop old column
    await queryRunner.query(`
      ALTER TABLE "${schemaName}"."${tableName}"
      DROP COLUMN "${oldColumnName}"
    `);
    // Drop temp enum type
    await this.dropOldEnumType(queryRunner, schemaName, tempEnumTypeName);
  }

  private async renameColumn(
    queryRunner: QueryRunner,
    schemaName: string,
    tableName: string,
    oldColumnName: string,
    newColumnName: string,
  ) {
    await queryRunner.query(`
      ALTER TABLE "${schemaName}"."${tableName}"
      RENAME COLUMN "${oldColumnName}" TO "${newColumnName}"
    `);
  }

  private migrateEnumValue(
    value: string,
    renamedEnumValues?: WorkspaceMigrationRenamedEnum[],
  ) {
    return (
      renamedEnumValues?.find((enumVal) => enumVal?.from === value)?.to || value
    );
  }

  private async migrateEnumValues(
    queryRunner: QueryRunner,
    schemaName: string,
    migrationColumn: WorkspaceMigrationColumnAlter,
    tableName: string,
    oldColumnName: string,
    enumValues: string[],
    renamedEnumValues?: WorkspaceMigrationRenamedEnum[],
  ) {
    const columnDefinition = migrationColumn.alteredColumnDefinition;

    const values = await queryRunner.query(
      `SELECT id, "${oldColumnName}" FROM "${schemaName}"."${tableName}"`,
    );

    values.map(async (value) => {
      let val = value[oldColumnName];

      if (/^\{.*\}$/.test(val)) {
        val = serializeDefaultValue(
          val
            .slice(1, -1)
            .split(',')
            .map((v: string) => v.trim())
            .map((v: string) => this.migrateEnumValue(v, renamedEnumValues))
            .filter((v: string) => enumValues.includes(v)),
        );
      } else if (typeof val === 'string') {
        val = `'${this.migrateEnumValue(val, renamedEnumValues)}'`;
      }

      await queryRunner.query(`
        UPDATE "${schemaName}"."${tableName}"
        SET "${columnDefinition.columnName}" = ${val}
        WHERE id='${value.id}'
      `);
    });
  }

  private async dropOldEnumType(
    queryRunner: QueryRunner,
    schemaName: string,
    oldEnumTypeName: string,
  ) {
    await queryRunner.query(
      `DROP TYPE IF EXISTS "${schemaName}"."${oldEnumTypeName}"`,
    );
  }

  private async renameEnumType(
    queryRunner: QueryRunner,
    schemaName: string,
    oldEnumTypeName: string,
    newEnumTypeName: string,
  ) {
    await queryRunner.query(`
      ALTER TYPE "${schemaName}"."${oldEnumTypeName}"
      RENAME TO "${newEnumTypeName}"
    `);
  }
}
