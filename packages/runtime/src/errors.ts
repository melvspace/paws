export class ContainerRuntimeError extends Error {}

export class RuntimeSetupError extends ContainerRuntimeError {
  readonly helper: string;
  readonly binary: string;

  constructor(helper: string, binary: string, cause: unknown) {
    super(
      "Paws sandbox is not configured on this computer. Complete Paws runtime setup during installation or deployment before starting the server.",
      { cause },
    );

    this.helper = helper;
    this.binary = binary;
  }
}
