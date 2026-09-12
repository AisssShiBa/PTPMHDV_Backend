package com.ptpmhdv.userservice.dto;

import com.ptpmhdv.userservice.model.KycStatus;
import jakarta.validation.constraints.NotNull;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
public class UpdateKycStatusRequest {

    @NotNull(message = "kycStatus is required")
    private KycStatus kycStatus;
}
