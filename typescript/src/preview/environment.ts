function optionalText(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

export function resolvePreviewEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const resolved = { ...env };
  const convexDeployment = optionalText(env.CONVEX_DEPLOYMENT);
  const deploymentVersion = optionalText(env.JARVIS_DEPLOYMENT_VERSION);

  if (deploymentVersion === undefined && convexDeployment !== undefined) {
    resolved.JARVIS_DEPLOYMENT_VERSION = convexDeployment;
  }

  return resolved;
}

export function applyPreviewEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const resolved = resolvePreviewEnvironment(env);
  const deploymentVersion = optionalText(resolved.JARVIS_DEPLOYMENT_VERSION);

  if (deploymentVersion !== undefined) {
    env.JARVIS_DEPLOYMENT_VERSION = deploymentVersion;
  }
}
