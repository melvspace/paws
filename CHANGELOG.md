# Changelog

## [0.3.0](https://github.com/melvspace/paws/compare/v0.2.0...v0.3.0) (2026-11-12)


### Features

* add linked environments and LAN/Tailscale discovery ([#10](https://github.com/melvspace/paws/issues/10)) ([e319410](https://github.com/melvspace/paws/commit/e319410660294be889c045fbfed100f2070a87c1))
* **chat:** dismiss obsolete conversation controls ([e0866be](https://github.com/melvspace/paws/commit/e0866be8914836eb22519844ed4b4e7a768b0bdc))
* **mobile:** add native app with device pairing ([57c8628](https://github.com/melvspace/paws/commit/57c8628d1fd33e6e3456036edacb7d31c8eda91e))
* **profiles:** infer agent profiles from activity ([1b41b65](https://github.com/melvspace/paws/commit/1b41b6519715ee9deeded2b91932e09af0619478))
* **runtime:** provision managed container runtimes ([36ab94e](https://github.com/melvspace/paws/commit/36ab94efa5769b0b312e114018876a1982690fd2))

## [0.2.0](https://github.com/melvspace/paws/compare/v0.1.0...v0.2.0) (2026-11-05)


### Features

* add agent routines and webhook triggers ([#3](https://github.com/melvspace/paws/issues/3)) ([43d783b](https://github.com/melvspace/paws/commit/43d783b52cc977dfbe870b58b4c49edd3e7a4778))
* add packaged clients and server image ([bf2d765](https://github.com/melvspace/paws/commit/bf2d765ab21705868c50d01e2bb56c035dbd8cd0))
* **browser:** add interactive agent browser sessions ([#7](https://github.com/melvspace/paws/issues/7)) ([b6bcc7a](https://github.com/melvspace/paws/commit/b6bcc7a3192316cf9219d4d9230cdf3cab20a258))
* build Paws agent workspace and provider management ([d6e5910](https://github.com/melvspace/paws/commit/d6e591097fc25d3fe85b75a1de8d6420a37d41d5))
* **chat:** add containerized multi-provider chat ([57c1963](https://github.com/melvspace/paws/commit/57c19634353bfc3f1d42bdc8f74101829757d523))
* **chat:** paginate and virtualize conversation history ([482dbd0](https://github.com/melvspace/paws/commit/482dbd05d1ce189041f940ecf7fd1dc8e8116431))
* **chat:** persist conversation read markers ([49e29c6](https://github.com/melvspace/paws/commit/49e29c6eea8524107a3a772163e3217d0e7673ff))
* **memory:** Add persistent agent and team memories ([f6c8c69](https://github.com/melvspace/paws/commit/f6c8c69309d617598bf24c73128fb544f4e1a5d5))
* **routines:** add nested webhook condition builder ([#4](https://github.com/melvspace/paws/issues/4)) ([b5fb090](https://github.com/melvspace/paws/commit/b5fb0908b3aa4302a19fb066713ad78d3d3efca9))
* **routines:** simplify webhooks to bearer-authenticated JSON ([be569d4](https://github.com/melvspace/paws/commit/be569d4abd580f106007dea1691ee09dfdff976b))
* **runtime:** Add persistent team environments and agent reassignment ([#5](https://github.com/melvspace/paws/issues/5)) ([1b76328](https://github.com/melvspace/paws/commit/1b763289a8e7bb21fbed68e75c7b3cab455051e5))
* **teams:** open team settings from the sidebar ([748f481](https://github.com/melvspace/paws/commit/748f4819741fdf115709c70faece485601713cda))
* **teamwork:** add agent collaboration tools ([#6](https://github.com/melvspace/paws/issues/6)) ([f2cd47a](https://github.com/melvspace/paws/commit/f2cd47ace98af9eb985209c12d6d1ca0d0d95234))
* **web:** add customizable animated avatars ([#1](https://github.com/melvspace/paws/issues/1)) ([d08caba](https://github.com/melvspace/paws/commit/d08caba903d7629ccbb72c3f5434c6b090a5d498))
* **web:** add standalone team creation dialog ([3a4170a](https://github.com/melvspace/paws/commit/3a4170a23fbbea4b9d04b2a5fb97248c3be4b5bb))
* **web:** Show conversation previews and unread counts ([34a8699](https://github.com/melvspace/paws/commit/34a86993a875104e2175914562431018f0705d72))


### Bug Fixes

* **chat:** adopt T3 context usage reporting ([6f1d97a](https://github.com/melvspace/paws/commit/6f1d97a10c98bd07ee37d82e4d86c74bfd603145))
* **chat:** bound tool loops and report progress ([6a104f6](https://github.com/melvspace/paws/commit/6a104f6bfdb5e89680b80c0860b6040f87ae2d96))
* **codex:** retain sessions between turns ([cf4d55f](https://github.com/melvspace/paws/commit/cf4d55fa48a1af1e464547ee7437dbf70d543c2a))
* **opencode:** show actionable provider errors ([a636a98](https://github.com/melvspace/paws/commit/a636a980840a08b2eca8281f057c55d68f43531b))
* **provider:** keep turns active during external command interactions ([bc30aeb](https://github.com/melvspace/paws/commit/bc30aeb82cc78d0c2401b1d9a8767c7c9264e8a7))
* **web:** align agent settings section widths ([21a3774](https://github.com/melvspace/paws/commit/21a37749d249ff15c7b94ae27a4aef311bb006d9))
* **web:** avoid UUID dependency for avatars ([54fe09d](https://github.com/melvspace/paws/commit/54fe09dc10732f2427217f4227d1c6afad90b8c7))
* **web:** keep attachment timestamps below file cards ([60db647](https://github.com/melvspace/paws/commit/60db6478d565b1b8b53cbaf1fe2acadac64dfc4a))
* **web:** keep saved chat messages above composer ([21d42da](https://github.com/melvspace/paws/commit/21d42da8bd56f492ac37b90d9977f8e8b36fccc9))
* **web:** simplify sidebar surfaces and tabs ([7dd3fea](https://github.com/melvspace/paws/commit/7dd3feae167b2cb43728fe1165c6bd7ce5940dbb))
