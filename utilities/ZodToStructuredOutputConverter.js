import logger from "./logger.js"

export class ZodToStructuredOutputConverter {
  convert(zodSchema) {
    if (!zodSchema || !zodSchema._def) {
      return {};
    }

    const zodType = zodSchema._def.typeName;

    switch (zodType) {
      case 'ZodString':
        return this.convertZodStringToStructuredOutput(zodSchema._def);
      case 'ZodNumber':
        return this.convertZodNumberToStructuredOutput(zodSchema._def);
      case 'ZodBoolean':
        return { type: 'boolean' };
      case 'ZodArray':
        return this.convertZodArrayToStructuredOutput(zodSchema._def);
      case 'ZodObject':
        return this.convertZodObjectToStructuredOutput(zodSchema._def);
      case 'ZodEnum':
        return this.convertZodEnumToStructuredOutput(zodSchema._def);
      case 'ZodOptional':
        // For Claude's structured outputs, optional fields are handled via the 'required' array
        // in the parent object, not via a 'nullable' property
        return this.convert(zodSchema._def.innerType);
      case 'ZodUnion':
        return this.convertZodUnionToStructuredOutput(zodSchema._def);
      case 'ZodLiteral':
        return this.convertZodLiteralToStructuredOutput(zodSchema._def);
      default:
        logger.warn(`Unsupported Zod type: ${zodType}`);
        return { type: 'string' };
    }
  }

  convertZodStringToStructuredOutput(def) {
    const schema = { type: 'string' };

    if (def.description) {
      schema.description = def.description;
    }

    return schema;
  }

  convertZodNumberToStructuredOutput(def) {
    const schema = { type: 'number' };

    if (def.description) {
      schema.description = def.description;
    }

    return schema;
  }

  convertZodArrayToStructuredOutput(def) {
    const schema = {
      type: 'array',
      items: this.convert(def.type)
    };

    if (def.description) {
      schema.description = def.description;
    }

    if (def.minLength !== null) {
      schema.minItems = def.minLength.value;
    }

    if (def.maxLength !== null) {
      schema.maxItems = def.maxLength.value;
    }

    return schema;
  }

  convertZodObjectToStructuredOutput(def) {
    const schema = {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false
    };

    if (def.description) {
      schema.description = def.description;
    }

    for (const [key, zodSchema] of Object.entries(def.shape())) {
      schema.properties[key] = this.convert(zodSchema);

      if (!zodSchema.isOptional()) {
        schema.required.push(key);
      }
    }

    return schema;
  }

  convertZodEnumToStructuredOutput(def) {
    const schema = {
      type: 'string',
      enum: def.values
    };

    if (def.description) {
      schema.description = def.description;
    }

    return schema;
  }

  convertZodUnionToStructuredOutput(def) {
    const options = def.options;

    // For nullable unions (T | null), just return the non-null type
    // Claude handles nullability through the 'required' array in parent objects
    if (options.length === 2 && options.some(opt => opt._def.typeName === 'ZodNull')) {
      const nonNullOption = options.find(opt => opt._def.typeName !== 'ZodNull');
      return this.convert(nonNullOption);
    }

    const enumValues = [];
    let allLiterals = true;

    for (const option of options) {
      if (option._def.typeName === 'ZodLiteral') {
        enumValues.push(option._def.value);
      } else {
        allLiterals = false;
        break;
      }
    }

    if (allLiterals && enumValues.length > 0) {
      return {
        type: typeof enumValues[0] === 'string' ? 'string' : 'number',
        enum: enumValues
      };
    }

    logger.warn('Complex union types not fully supported, defaulting to string');
    return { type: 'string' };
  }

  convertZodLiteralToStructuredOutput(def) {
    return {
      type: typeof def.value === 'string' ? 'string' : 'number',
      enum: [def.value]
    };
  }
}