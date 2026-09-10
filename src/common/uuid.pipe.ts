import { BadRequestException, ParseUUIDPipe } from '@nestjs/common';

export function createUuidPipe() {
  return new ParseUUIDPipe({
    exceptionFactory: () =>
      new BadRequestException('El identificador no es válido.'),
  });
}
