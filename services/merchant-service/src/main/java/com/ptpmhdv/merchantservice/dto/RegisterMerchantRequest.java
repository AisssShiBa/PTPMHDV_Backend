package com.ptpmhdv.merchantservice.dto;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

@Data
public class RegisterMerchantRequest {

    @NotBlank(message = "businessName is required")
    private String businessName;

    private String taxId;
    private String bankAccount;
}
